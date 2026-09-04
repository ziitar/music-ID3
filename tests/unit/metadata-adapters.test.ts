import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ipcChannels } from "../../shared/ipc";
import type { MetadataCandidate, MetadataSource } from "../../shared/types";
import { registerIpcHandlers } from "../../electron/ipc/register-ipc";
import { scoreCandidate, type MetadataAdapter } from "../../electron/services/metadata/adapter";
import { createCtdbAdapter } from "../../electron/services/metadata/ctdb-adapter";
import {
  createHttpClient,
  HttpRequestError,
  type HttpTransport,
  type HttpTransportRequest,
  type HttpTransportResponse
} from "../../electron/services/metadata/http-client";
import { createMusicBrainzAdapter } from "../../electron/services/metadata/musicbrainz-adapter";
import { createNeteaseAdapter } from "../../electron/services/metadata/netease-adapter";
import { createQqMusicAdapter } from "../../electron/services/metadata/qqmusic-adapter";

const fixtureDirectory = path.join(process.cwd(), "tests", "fixtures", "metadata");

async function fixture(name: string): Promise<string> {
  return readFile(path.join(fixtureDirectory, name), "utf8");
}

function response(body: string | Uint8Array, status = 200, headers: Record<string, string> = {}): HttpTransportResponse {
  return { status, headers, body };
}

function queueTransport(responses: Array<HttpTransportResponse | Error>): {
  transport: HttpTransport;
  requests: HttpTransportRequest[];
} {
  const requests: HttpTransportRequest[] = [];
  const transport: HttpTransport = async (request) => {
    requests.push(request);
    const next = responses.shift();
    if (!next) throw new Error("Unexpected transport request");
    if (next instanceof Error) throw next;
    return next;
  };
  return { transport, requests };
}

function clientFor(transport: HttpTransport) {
  return createHttpClient({
    transport,
    policies: {
      musicbrainz: { minIntervalMs: 0, retries: 0 },
      ctdb: { minIntervalMs: 0, retries: 0 },
      netease: { minIntervalMs: 0, retries: 0 },
      qq: { minIntervalMs: 0, retries: 0 }
    }
  });
}

describe("metadata adapters", () => {
  it("maps MusicBrainz release search results without claiming high confidence from names", async () => {
    const queued = queueTransport([response(await fixture("musicbrainz-search.json"))]);
    const adapter = createMusicBrainzAdapter({ http: clientFor(queued.transport), userAgent: "MusicID3Tests/1.0 (tests@example.invalid)" });

    await expect(adapter.search("Miles Davis Kind of Blue")).resolves.toEqual([
      expect.objectContaining({
        id: "f34dcbf5-2f9d-4f7f-8c8d-3d78deedc84b",
        source: "musicbrainz",
        title: "Kind of Blue",
        album: "Kind of Blue",
        artist: "Miles Davis",
        date: "1959-08-17",
        country: "US",
        format: "CD",
        trackCount: 5,
        confidence: "low"
      })
    ]);
    expect(queued.requests[0].url).toContain("/ws/2/release/?query=Miles%20Davis%20Kind%20of%20Blue&fmt=json&limit=25");
    expect(queued.requests[0].headers["User-Agent"]).toBe("MusicID3Tests/1.0 (tests@example.invalid)");
  });

  it("requests MusicBrainz media, disc IDs, and recordings and maps CUE-compatible offsets", async () => {
    const queued = queueTransport([response(await fixture("musicbrainz-release.json"))]);
    const adapter = createMusicBrainzAdapter({ http: clientFor(queued.transport), userAgent: "MusicID3Tests/1.0 (tests@example.invalid)" });

    await expect(adapter.getDetails("f34dcbf5-2f9d-4f7f-8c8d-3d78deedc84b")).resolves.toMatchObject({
      source: "musicbrainz",
      title: "Kind of Blue",
      discId: "abc123-disc-id",
      discIds: ["abc123-disc-id"],
      offsets: [150, 13500],
      totalDurationMs: 1134000,
      tracks: [
        { number: 1, title: "So What", artist: "Miles Davis", durationMs: 545000 },
        { number: 2, title: "Freddie Freeloader", artist: "Miles Davis", durationMs: 589000 }
      ]
    });
    expect(queued.requests[0].url).toContain("inc=artist-credits%2Bmedia%2Bdiscids%2Brecordings");
  });

  it("resolves a Cover Art Archive front-cover URL and returns encoded image bytes", async () => {
    const imageBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    const queued = queueTransport([
      response(await fixture("cover-art-archive.json")),
      response(imageBytes, 200, { "content-type": "image/jpeg" })
    ]);
    const adapter = createMusicBrainzAdapter({ http: clientFor(queued.transport), userAgent: "MusicID3Tests/1.0 (tests@example.invalid)" });

    await expect(adapter.getCover({ id: "f34dcbf5-2f9d-4f7f-8c8d-3d78deedc84b" } as MetadataCandidate)).resolves.toEqual({
      mimeType: "image/jpeg",
      data: Buffer.from(imageBytes).toString("base64")
    });
    expect(queued.requests.map((request) => request.url)).toEqual([
      "https://coverartarchive.org/release/f34dcbf5-2f9d-4f7f-8c8d-3d78deedc84b",
      "https://coverartarchive.org/release/f34dcbf5-2f9d-4f7f-8c8d-3d78deedc84b/829521842-500.jpg"
    ]);
  });

  it("returns typed non-blocking CTDB results for no match and network failure", async () => {
    const noMatch = createCtdbAdapter({ http: clientFor(queueTransport([response(await fixture("ctdb-no-match.xml"))]).transport) });
    await expect(noMatch.validate("0+150+13500+27000")).resolves.toEqual({
      status: "no-match",
      evidence: ["CTDB returned no matching pressing"]
    });

    const unavailable = createCtdbAdapter({ http: clientFor(queueTransport([new Error("secret upstream failure")]).transport) });
    await expect(unavailable.validate("0+150+13500+27000")).resolves.toEqual({
      status: "unavailable",
      error: "CTDB validation is unavailable",
      evidence: []
    });
  });

  it("maps NetEase search/detail fixtures and obtains the current Cookie for every request", async () => {
    const queued = queueTransport([
      response(await fixture("netease-search.json")),
      response(await fixture("netease-detail.json"))
    ]);
    let cookie = "MUSIC_U=first-secret";
    const adapter = createNeteaseAdapter({
      http: clientFor(queued.transport),
      cookieStore: { get: async () => cookie }
    });

    await expect(adapter.search("Mystery of Love")).resolves.toEqual([
      expect.objectContaining({
        id: "1859245776",
        source: "netease",
        title: "Mystery of Love",
        artist: "Sufjan Stevens",
        album: "Call Me by Your Name",
        totalDurationMs: 248000,
        coverUrl: "https://p1.music.126.net/example/109951.jpg"
      })
    ]);
    cookie = "MUSIC_U=rotated-secret";
    const details = await adapter.getDetails("1859245776");
    expect(details).toMatchObject({ title: "Mystery of Love", totalDurationMs: 248000 });
    expect(queued.requests.map((request) => request.headers.Cookie)).toEqual([
      "MUSIC_U=first-secret",
      "MUSIC_U=rotated-secret"
    ]);
    expect(JSON.stringify(details)).not.toContain("secret");
  });

  it("maps QQ search/detail fixtures and derives the upstream album-cover URL", async () => {
    const queued = queueTransport([
      response(await fixture("qq-search.json")),
      response(await fixture("qq-detail.json")),
      response(Uint8Array.from([1, 2, 3]), 200, { "content-type": "image/jpeg" })
    ]);
    const adapter = createQqMusicAdapter({
      http: clientFor(queued.transport),
      cookieStore: { get: async () => "uin=12345; qm_keyst=qq-secret" }
    });

    const [candidate] = await adapter.search("Mojito");
    expect(candidate).toMatchObject({
      id: "0039MnYb0qxYhV",
      source: "qq",
      title: "Mojito",
      artist: "Jay Chou",
      album: "Mojito",
      totalDurationMs: 185000,
      coverUrl: "https://y.gtimg.cn/music/photo_new/T002R500x500M0000016l2F430zMux.jpg?max_age=2592000"
    });
    await expect(adapter.getDetails(candidate.id)).resolves.toMatchObject({ id: candidate.id, artist: "Jay Chou", album: "Mojito" });
    await expect(adapter.getCover(candidate)).resolves.toEqual({ mimeType: "image/jpeg", data: "AQID" });
    expect(queued.requests.every((request) => request.headers.Cookie === "uin=12345; qm_keyst=qq-secret")).toBe(true);
  });
});

describe("main-process HTTP client", () => {
  it("caches session responses and rate-limits requests per provider", async () => {
    let now = 1000;
    const waits: number[] = [];
    const queued = queueTransport([response("{\"value\":1}"), response("{\"value\":2}")]);
    const http = createHttpClient({
      transport: queued.transport,
      now: () => now,
      sleep: async (milliseconds) => { waits.push(milliseconds); now += milliseconds; },
      policies: { musicbrainz: { minIntervalMs: 1000, retries: 0 } }
    });

    await expect(http.getJson("musicbrainz", "https://example.test/one", { cacheTtlMs: 60000 })).resolves.toEqual({ value: 1 });
    await expect(http.getJson("musicbrainz", "https://example.test/one", { cacheTtlMs: 60000 })).resolves.toEqual({ value: 1 });
    await expect(http.getJson("musicbrainz", "https://example.test/two")).resolves.toEqual({ value: 2 });
    expect(queued.requests).toHaveLength(2);
    expect(waits).toEqual([1000]);
  });

  it("serializes concurrent requests through the provider rate limit", async () => {
    let now = 1000;
    const dispatchTimes: number[] = [];
    const http = createHttpClient({
      transport: async () => {
        dispatchTimes.push(now);
        return response("{}");
      },
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
      policies: { musicbrainz: { minIntervalMs: 1000, retries: 0 } }
    });

    await Promise.all([
      http.getJson("musicbrainz", "https://example.test/one"),
      http.getJson("musicbrainz", "https://example.test/two"),
      http.getJson("musicbrainz", "https://example.test/three")
    ]);

    expect(dispatchTimes).toEqual([1000, 2000, 3000]);
  });

  it("retries only bounded transient failures and redacts secrets from diagnostics and errors", async () => {
    const diagnostics: string[] = [];
    const queued = queueTransport([new TypeError("fetch failed Cookie=stolen"), response("{\"ok\":true}")]);
    const http = createHttpClient({
      transport: queued.transport,
      diagnostics: (entry) => diagnostics.push(JSON.stringify(entry)),
      policies: { netease: { minIntervalMs: 0, retries: 1 } }
    });

    await expect(http.getJson("netease", "https://example.test/data?token=query-secret", {
      getHeaders: async () => ({ Cookie: "MUSIC_U=header-secret", Authorization: "Bearer bearer-secret" })
    })).resolves.toEqual({ ok: true });
    expect(queued.requests).toHaveLength(2);
    expect(diagnostics.join(" ")).not.toMatch(/stolen|query-secret|header-secret|bearer-secret|MUSIC_U/);

    const permanentQueue = queueTransport([response("denied", 401)]);
    const permanent = createHttpClient({
      transport: permanentQueue.transport,
      policies: { netease: { minIntervalMs: 0, retries: 3 } }
    });
    await expect(permanent.getJson("netease", "https://example.test/private", {
      getHeaders: async () => ({ Cookie: "private-secret" })
    })).rejects.toMatchObject({ name: "HttpRequestError", status: 401 });
    expect(permanentQueue.requests).toHaveLength(1);
  });

  it("supports caller cancellation and request timeout without retrying", async () => {
    let attempts = 0;
    const transport: HttpTransport = ({ signal }) => new Promise((_resolve, reject) => {
      attempts += 1;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    const http = createHttpClient({ transport, defaultTimeoutMs: 5, policies: { qq: { minIntervalMs: 0, retries: 2 } } });

    await expect(http.getJson("qq", "https://example.test/slow")).rejects.toBeInstanceOf(HttpRequestError);
    expect(attempts).toBe(1);

    const controller = new AbortController();
    controller.abort(new Error("caller stopped"));
    await expect(http.getJson("qq", "https://example.test/cancelled", { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError"
    });
    expect(attempts).toBe(1);
  });
});

describe("candidate scoring and IPC", () => {
  it("keeps name-only matches low and requires structural evidence for high confidence", () => {
    const namesOnly = scoreCandidate(
      { title: "Kind of Blue", artist: "Miles Davis" },
      { id: "one", source: "musicbrainz", title: "Kind of Blue", artist: "Miles Davis", confidence: "low" }
    );
    expect(namesOnly).toMatchObject({ confidence: "low" });
    expect(namesOnly.score).toBeLessThan(50);

    const structural = scoreCandidate(
      {
        title: "Kind of Blue",
        artist: "Miles Davis",
        trackCount: 2,
        durationMs: 1133000,
        trackDurationsMs: [545500, 587500],
        discId: "abc123-disc-id",
        toc: "0+150+13500+27000"
      },
      {
        id: "two",
        source: "musicbrainz",
        title: "Kind of Blue",
        artist: "Miles Davis",
        trackCount: 2,
        totalDurationMs: 1134000,
        tracks: [
          { number: 1, title: "So What", durationMs: 545000 },
          { number: 2, title: "Freddie Freeloader", durationMs: 589000 }
        ],
        discId: "abc123-disc-id",
        toc: "0+150+13500+27000",
        ctdb: { status: "match", confidence: 12 },
        confidence: "low"
      }
    );
    expect(structural).toMatchObject({ confidence: "high", score: 100 });
    expect(structural.evidence).toEqual(expect.arrayContaining(["Disc ID matched", "TOC matched", "CTDB verified the pressing"]));
  });

  it("delegates metadata search and Cookie connectivity checks without returning a Cookie", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const candidate: MetadataCandidate = { id: "result", source: "netease", title: "Found", confidence: "low" };
    const adapters = Object.fromEntries((["musicbrainz", "ctdb", "netease", "qq"] as MetadataSource[]).map((source) => [source, {
      search: async () => source === "netease" ? [candidate] : [],
      getDetails: async () => candidate,
      getCover: async () => undefined,
      testConnection: async () => undefined
    } satisfies MetadataAdapter])) as Record<MetadataSource, MetadataAdapter>;

    registerIpcHandlers({
      ipcMain: { handle(channel, listener) { handlers.set(channel, listener); } },
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      cookieStore: { set: async () => undefined, redacted: async () => "configured" },
      metadataAdapters: adapters
    });

    await expect(handlers.get(ipcChannels.searchMetadata)?.({}, "netease", "Found")).resolves.toEqual([candidate]);
    await expect(handlers.get(ipcChannels.testProviderCookie)?.({}, "netease")).resolves.toEqual({ ok: true, status: "configured" });
    expect(JSON.stringify(await handlers.get(ipcChannels.testProviderCookie)?.({}, "netease"))).not.toContain("Cookie");
  });
});
