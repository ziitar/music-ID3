import { createServer, type Server } from "node:http";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import iconv from "iconv-lite";
import { _electron as electron, test as base, type ElectronApplication, type Page } from "playwright/test";

type RelaunchedApplication = { electronApp: ElectronApplication; page: Page };
type AppSession = RelaunchedApplication & { relaunch(): Promise<RelaunchedApplication> };
type ProviderFixture = { origin: string; server: Server };

type Fixtures = {
  appSession: AppSession;
  electronApp: ElectronApplication;
  fixtureRoot: string;
  page: Page;
  provider: ProviderFixture;
  relaunch: () => Promise<RelaunchedApplication>;
  userDataPath: string;
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

async function providerServer(): Promise<ProviderFixture> {
  const [search, release, covers, neteaseSearch, neteaseDetail, qqSearch, qqDetail] = await Promise.all([
    readFile(path.join(metadataSource, "musicbrainz-search.json")),
    readFile(path.join(metadataSource, "musicbrainz-release.json")),
    readFile(path.join(metadataSource, "cover-art-archive.json")),
    readFile(path.join(metadataSource, "netease-search.json")),
    readFile(path.join(metadataSource, "netease-detail.json")),
    readFile(path.join(metadataSource, "qq-search.json")),
    readFile(path.join(metadataSource, "qq-detail.json"))
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
    if (original.includes("interfacepc.music.163.com/eapi/search/get")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(neteaseSearch);
      return;
    }
    if (original.includes("music.163.com/weapi/v3/song/detail")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(neteaseDetail);
      return;
    }
    if (original.includes("c.y.qq.com/soso/fcgi-bin/client_search_cp")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(qqSearch);
      return;
    }
    if (original.includes("u.y.qq.com/cgi-bin/musicu.fcg")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(qqDetail);
      return;
    }
    if (original.includes("p1.music.126.net/") || original.includes("y.gtimg.cn/") || original.endsWith(".jpg")) {
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

async function launchApplication(fixtureRoot: string, providerOrigin: string, userDataPath: string): Promise<RelaunchedApplication> {
  const electronApp = await electron.launch({
    args: [
      process.cwd(),
      `--music-id3-e2e-root=${fixtureRoot}`,
      `--music-id3-e2e-provider-origin=${providerOrigin}`,
      `--music-id3-e2e-user-data=${userDataPath}`,
      "--music-id3-e2e-scan-delay-ms=125"
    ],
    env: childEnvironment({ MUSIC_ID3_E2E: "1" })
  });
  const page = await electronApp.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(() => localStorage.setItem("music-id3.locale", "en-US"));
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  return { electronApp, page };
}

export const test = base.extend<Fixtures>({
  fixtureRoot: async ({}, use) => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "music-id3-e2e-"));
    const root = path.join(parent, "音乐 测试库");
    await cp(fixtureSource, root, { recursive: true });
    const legacyCue = [
      'TITLE "中华人民共和国音乐唱片测试专辑你好世界"',
      'PERFORMER "中国音乐艺术家"',
      'FILE "album/disc.WaV" WAVE',
      "  TRACK 01 AUDIO",
      '    TITLE "第一轨道音乐"',
      "    INDEX 01 00:00:00"
    ].join("\n");
    await writeFile(path.join(root, "旧编码.cue"), iconv.encode(legacyCue, "gb18030"));
    await use(root);
    await rm(parent, { recursive: true, force: true });
  },
  userDataPath: async ({}, use) => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "music-id3-e2e-profile-"));
    await use(path.join(parent, "profile"));
    await rm(parent, { recursive: true, force: true });
  },
  provider: async ({}, use) => {
    const provider = await providerServer();
    try { await use(provider); } finally { await closeServer(provider.server); }
  },
  appSession: async ({ fixtureRoot, provider, userDataPath }, use) => {
    let current = await launchApplication(fixtureRoot, provider.origin, userDataPath);
    const session: AppSession = {
      ...current,
      async relaunch() {
        await current.electronApp.close();
        current = await launchApplication(fixtureRoot, provider.origin, userDataPath);
        session.electronApp = current.electronApp;
        session.page = current.page;
        return current;
      }
    };
    try { await use(session); } finally { await current.electronApp.close().catch(() => undefined); }
  },
  electronApp: async ({ appSession }, use) => { await use(appSession.electronApp); },
  page: async ({ appSession }, use) => { await use(appSession.page); },
  relaunch: async ({ appSession }, use) => { await use(() => appSession.relaunch()); }
});

export { expect } from "playwright/test";
