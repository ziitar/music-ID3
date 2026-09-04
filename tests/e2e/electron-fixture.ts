import { createServer, type Server } from "node:http";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron as electron, test as base, type ElectronApplication, type Page } from "playwright/test";

type Fixtures = {
  electronApp: ElectronApplication;
  fixtureRoot: string;
  page: Page;
};

const fixtureSource = path.join(process.cwd(), "tests", "fixtures", "library");
const metadataSource = path.join(process.cwd(), "tests", "fixtures", "metadata");

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function childEnvironment(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([name, value]) => name !== "NO_COLOR" && value !== undefined)),
    ...extra
  } as Record<string, string>;
}

async function providerServer(): Promise<{ origin: string; server: Server }> {
  const [search, release, covers] = await Promise.all([
    readFile(path.join(metadataSource, "musicbrainz-search.json")),
    readFile(path.join(metadataSource, "musicbrainz-release.json")),
    readFile(path.join(metadataSource, "cover-art-archive.json"))
  ]);
  const cover = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const server = createServer((request, response) => {
    const original = decodeURIComponent((request.url ?? "/").slice(1));
    response.setHeader("Cache-Control", "no-store");
    if (original.includes("query=offline")) {
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "private-provider-token-must-not-render" }));
      return;
    }
    if (original.includes("musicbrainz.org/ws/2/release/?")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(search);
      return;
    }
    if (original.includes("musicbrainz.org/ws/2/release/")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(release);
      return;
    }
    if (original.includes("coverartarchive.org/release/") && !original.endsWith(".jpg")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(covers);
      return;
    }
    if (original.endsWith(".jpg")) {
      response.writeHead(200, { "Content-Type": "image/png" });
      response.end(cover);
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "unmatched provider request" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock provider server did not bind a TCP port");
  return { origin: `http://127.0.0.1:${address.port}`, server };
}

export const test = base.extend<Fixtures>({
  fixtureRoot: async ({}, use) => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "music-id3-e2e-"));
    const root = path.join(parent, "Fixture Library");
    await cp(fixtureSource, root, { recursive: true });
    await use(root);
    await rm(parent, { recursive: true, force: true });
  },
  electronApp: async ({ fixtureRoot }, use) => {
    const provider = await providerServer();
    let app: ElectronApplication | undefined;
    try {
      app = await electron.launch({
        args: [
          process.cwd(),
          `--music-id3-e2e-root=${fixtureRoot}`,
          `--music-id3-e2e-provider-origin=${provider.origin}`,
          "--music-id3-e2e-scan-delay-ms=125"
        ],
        env: childEnvironment({ MUSIC_ID3_E2E: "1" })
      });
      await use(app);
    } finally {
      await app?.close();
      await closeServer(provider.server);
    }
  },
  page: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await use(page);
  }
});

export { expect } from "playwright/test";
