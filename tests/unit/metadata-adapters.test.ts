import { readFile } from "node:fs/promises";
import { createDecipheriv } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ipcChannels } from "../../shared/ipc";
import type { MetadataCandidate, MetadataSource } from "../../shared/types";
import { registerIpcHandlers } from "../../electron/ipc/register-ipc";
import { scoreCandidate, type MetadataAdapter } from "../../electron/services/metadata/adapter";
import { createCtdbAdapter, toCtdbToc } from "../../electron/services/metadata/ctdb-adapter";
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

function decryptAes(value: string, encoding: "hex" | "base64", mode: "ecb" | "cbc", key: string): string {
  const decipher = createDecipheriv(`aes-128-${mode}`, Buffer.from(key), mode === "cbc" ? Buffer.from("0102030405060708") : null);
  return Buffer.concat([decipher.update(Buffer.from(value, encoding)), decipher.final()]).toString("utf8");
}

function decryptEapi(params: string): { path: string; data: Record<string, unknown> } {
  const plaintext = decryptAes(params, "hex", "ecb", "e82ckenh8dichen8");
  const match = plaintext.match(/^(.*?)-36cd479b6b5-(.*)-36cd479b6b5-[a-f0-9]{32}$/);
  if (!match) throw new Error("Invalid EAPI fixture request");
  return { path: match[1], data: JSON.parse(match[2]) as Record<string, unknown> };
}

function decryptWeapi(params: string, secretKey: string): Record<string, unknown> {
  const firstLayer = decryptAes(params, "base64", "cbc", secretKey);
  return JSON.parse(decryptAes(firstLayer, "base64", "cbc", "0CoJUm6Qyw8W8jud")) as Record<string, unknown>;
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

  it("uses the meaningful project User-Agent by default and supports an override", async () => {
    const queued = queueTransport([response(await fixture("musicbrainz-search.json"))]);
    const adapter = createMusicBrainzAdapter({ http: clientFor(queued.transport) });
    await adapter.search("Kind of Blue");
    expect(queued.requests[0].headers["User-Agent"]).toBe("MusicID3Desktop/1.0 (https://github.com/uziit/music-ID3)");
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

  it("converts MusicBrainz offsets and lead-out to the CTDB lookup2 TOC format", async () => {
    const disc = JSON.parse(await fixture("musicbrainz-disc.json")) as { offsets: number[]; sectors: number };
    expect(toCtdbToc(disc)).toBe("0:15213:32164:46442:63264:80339:95312");
  });

  it("returns typed non-blocking CTDB results for HTTP 404 and network failure", async () => {
    const noMatchQueue = queueTransport([response("", 404)]);
    const noMatch = createCtdbAdapter({ http: clientFor(noMatchQueue.transport) });
    await expect(noMatch.validate("0:13350:26850")).resolves.toEqual({
      status: "no-match",
      evidence: ["CTDB returned no matching pressing"]
    });
    expect(noMatchQueue.requests[0].url).toContain("https://db.cuetools.net/lookup2.php");

    const unavailable = createCtdbAdapter({ http: clientFor(queueTransport([new Error("secret upstream failure")]).transport) });
    await expect(unavailable.validate("0:13350:26850")).resolves.toEqual({
      status: "unavailable",
      error: "CTDB validation is unavailable",
      evidence: []
    });
  });

  it("preserves CTDB cancellation and rejects non-server protocol failures", async () => {
    const controller = new AbortController();
    const cancelling = createCtdbAdapter({
      http: clientFor(({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }))
    });
    const cancelled = cancelling.validate("0:13350:26850", controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });

    const invalid = createCtdbAdapter({ http: clientFor(queueTransport([response("invalid toc", 400)]).transport) });
    await expect(invalid.validate("0:13350:26850")).rejects.toMatchObject({ name: "HttpRequestError", status: 400 });
  });

  it("maps NetEase search/detail fixtures and obtains the current Cookie for every request", async () => {
    const queued = queueTransport([
      response(await fixture("netease-search.json")),
      response(await fixture("netease-detail.json"))
    ]);
    let cookie = "MUSIC_U=first-secret";
    const adapter = createNeteaseAdapter({
      http: clientFor(queued.transport),
      cookieStore: { get: async () => cookie },
      now: () => 1700000000123,
      randomBytes: (size: number) => Buffer.from(Array.from({ length: size }, (_value, index) => index))
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
    cookie = "MUSIC_U=rotated-secret; __csrf=csrf-value";
    const details = await adapter.getDetails("1859245776");
    expect(details).toMatchObject({ title: "Mystery of Love", totalDurationMs: 248000 });
    expect(queued.requests.map((request) => request.headers.Cookie)).toEqual([
      "MUSIC_U=first-secret",
      "MUSIC_U=rotated-secret; __csrf=csrf-value"
    ]);
    expect(JSON.stringify(details)).not.toContain("secret");

    const expected = JSON.parse(await fixture("netease-request-shapes.json")) as {
      search: { url: string; method: string; cryptoPath: string; fields: Record<string, unknown> };
      detail: { url: string; method: string; fields: Record<string, unknown> };
    };
    expect(queued.requests[0]).toMatchObject({ url: expected.search.url, method: expected.search.method });
    const eapiBody = new URLSearchParams(queued.requests[0].body as string);
    const decryptedSearch = decryptEapi(eapiBody.get("params") ?? "");
    expect(decryptedSearch.path).toBe(expected.search.cryptoPath);
    expect(decryptedSearch.data).toMatchObject(expected.search.fields);

    expect(queued.requests[1]).toMatchObject({ url: expected.detail.url, method: expected.detail.method });
    const weapiBody = new URLSearchParams(queued.requests[1].body as string);
    expect(decryptWeapi(weapiBody.get("params") ?? "", "abcdefghijklmnop")).toMatchObject(expected.detail.fields);
    expect(weapiBody.get("encSecKey")).toMatch(/^[a-f0-9]{256}$/);
  });

  it("uses a finite auth-sensitive session cache for NetEase searches", async () => {
    let cookie = "MUSIC_U=first";
    const first = await fixture("netease-search.json");
    const second = first.replace("Mystery of Love", "Rotated Result");
    const queued = queueTransport([response(first), response(second)]);
    const adapter = createNeteaseAdapter({
      http: clientFor(queued.transport),
      cookieStore: { get: async () => cookie }
    });

    await expect(adapter.search("cache-key")).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ title: "Mystery of Love" })]));
    await expect(adapter.search("cache-key")).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ title: "Mystery of Love" })]));
    cookie = "MUSIC_U=rotated";
    await expect(adapter.search("cache-key")).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ title: "Rotated Result" })]));
    expect(queued.requests).toHaveLength(2);
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
    expect(queued.requests.slice(0, 2).every((request) => request.headers.Cookie === "uin=12345; qm_keyst=qq-secret")).toBe(true);
    expect(queued.requests[2].headers.Cookie).toBeUndefined();
    expect(queued.requests[2].maxResponseBytes).toBe(20 * 1024 * 1024);

    const expected = JSON.parse(await fixture("qq-request-shapes.json")) as Record<"search" | "detail", {
      host: string;
      referer: string;
      contentType?: string;
      params: Record<string, string>;
    }>;
    const searchUrl = new URL(queued.requests[0].url);
    const detailUrl = new URL(queued.requests[1].url);
    expect(Object.fromEntries(Object.keys(expected.search.params).map((key) => [key, searchUrl.searchParams.get(key)]))).toEqual(expected.search.params);
    expect(queued.requests[0].headers).toMatchObject({ Host: expected.search.host, Referer: expected.search.referer });
    expect(Object.fromEntries(Object.keys(expected.detail.params).map((key) => [key, detailUrl.searchParams.get(key)]))).toEqual(expected.detail.params);
    expect(queued.requests[1].headers).toMatchObject({
      Host: expected.detail.host,
      Referer: expected.detail.referer,
      "Content-Type": expected.detail.contentType
    });
  });

  it("uses a finite auth-sensitive session cache for QQ searches", async () => {
    let cookie = "uin=12345; qm_keyst=first";
    const first = await fixture("qq-search.json");
    const second = first.replace("Mojito", "Rotated Result");
    const queued = queueTransport([response(first), response(second)]);
    const adapter = createQqMusicAdapter({
      http: clientFor(queued.transport),
      cookieStore: { get: async () => cookie }
    });

    await expect(adapter.search("cache-key")).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ title: "Mojito" })]));
    await expect(adapter.search("cache-key")).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ title: "Mojito" })]));
    cookie = "uin=67890; qm_keyst=second";
    await expect(adapter.search("cache-key")).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ title: "Rotated Result" })]));
    expect(queued.requests).toHaveLength(2);
  });

  it("fetches provider covers only from approved HTTPS CDNs and never sends Cookies", async () => {
    const neteaseQueue = queueTransport([response(Uint8Array.from([1]), 200, { "content-type": "image/jpeg" })]);
    const netease = createNeteaseAdapter({
      http: clientFor(neteaseQueue.transport),
      cookieStore: { get: async () => "MUSIC_U=do-not-send" }
    });
    await netease.getCover({
      id: "1",
      source: "netease",
      title: "One",
      confidence: "low",
      coverUrl: "https://p1.music.126.net/example/cover.jpg"
    });
    expect(neteaseQueue.requests[0].headers.Cookie).toBeUndefined();
    expect(neteaseQueue.requests[0].maxResponseBytes).toBe(20 * 1024 * 1024);

    const blockedQueue = queueTransport([]);
    const qq = createQqMusicAdapter({
      http: clientFor(blockedQueue.transport),
      cookieStore: { get: async () => "uin=do-not-send" }
    });
    await expect(qq.getCover({
      id: "2",
      source: "qq",
      title: "Two",
      confidence: "low",
      coverUrl: "https://attacker.invalid/capture"
    })).rejects.toThrow(/cover URL/i);
    await expect(netease.getCover({
      id: "3",
      source: "netease",
      title: "Three",
      confidence: "low",
      coverUrl: "http://p1.music.126.net/insecure.jpg"
    })).rejects.toThrow(/cover URL/i);
    expect(blockedQueue.requests).toHaveLength(0);
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

  it("rate-limits actual concurrent dispatch after dynamic header resolution", async () => {
    let now = 1000;
    const dispatchTimes: number[] = [];
    const headerDelays = [2000, 0, 500];
    const http = createHttpClient({
      transport: async () => {
        dispatchTimes.push(now);
        return response("{}");
      },
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
      policies: { qq: { minIntervalMs: 1000, retries: 0 } }
    });

    await Promise.all(headerDelays.map((headerDelay, index) => http.getJson(
      "qq",
      `https://example.test/${index}`,
      { getHeaders: async () => { now += headerDelay; return { Cookie: `cookie-${index}` }; } }
    )));

    expect(dispatchTimes).toEqual([3500, 4500, 5500]);
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

  it("enforces declared and actual response byte limits with an explicit larger cover limit", async () => {
    const declared = createHttpClient({
      transport: queueTransport([response("small", 200, { "content-length": "100" })]).transport,
      defaultMaxResponseBytes: 10,
      policies: { netease: { minIntervalMs: 0, retries: 0 } }
    });
    await expect(declared.getBytes("netease", "https://example.test/declared")).rejects.toThrow(/size limit/i);

    const actual = createHttpClient({
      transport: queueTransport([response(Uint8Array.from({ length: 11 }, () => 1))]).transport,
      defaultMaxResponseBytes: 10,
      policies: { netease: { minIntervalMs: 0, retries: 0 } }
    });
    await expect(actual.getBytes("netease", "https://example.test/actual")).rejects.toThrow(/size limit/i);

    const cover = createHttpClient({
      transport: queueTransport([response(Uint8Array.from({ length: 11 }, () => 1))]).transport,
      defaultMaxResponseBytes: 10,
      policies: { netease: { minIntervalMs: 0, retries: 0 } }
    });
    await expect(cover.getBytes("netease", "https://example.test/cover", { maxResponseBytes: 20 })).resolves.toMatchObject({
      data: expect.objectContaining({ byteLength: 11 })
    });
  });

  it("bounds the session cache with LRU eviction and removes expired entries", async () => {
    let now = 1000;
    const queued = queueTransport([
      response("{\"value\":1}"),
      response("{\"value\":2}"),
      response("{\"value\":3}"),
      response("{\"value\":22}"),
      response("{\"value\":11}")
    ]);
    const http = createHttpClient({
      transport: queued.transport,
      maxCacheEntries: 2,
      now: () => now,
      policies: { musicbrainz: { minIntervalMs: 0, retries: 0 } }
    });
    const cache = { cacheTtlMs: 10 };

    await http.getJson("musicbrainz", "https://example.test/one", cache);
    await http.getJson("musicbrainz", "https://example.test/two", cache);
    await http.getJson("musicbrainz", "https://example.test/one", cache);
    await http.getJson("musicbrainz", "https://example.test/three", cache);
    await expect(http.getJson("musicbrainz", "https://example.test/two", cache)).resolves.toEqual({ value: 22 });
    now = 1011;
    await expect(http.getJson("musicbrainz", "https://example.test/one", cache)).resolves.toEqual({ value: 11 });
    expect(queued.requests).toHaveLength(5);
  });

  it("resolves auth before cache lookup and keys cache entries by a hidden auth digest", async () => {
    let cookie = "session=first-private-value";
    let headerReads = 0;
    const diagnostics: string[] = [];
    const queued = queueTransport([response("{\"value\":1}"), response("{\"value\":2}")]);
    const http = createHttpClient({
      transport: queued.transport,
      diagnostics: (entry) => diagnostics.push(JSON.stringify(entry)),
      policies: { qq: { minIntervalMs: 0, retries: 0 } }
    });
    const request = () => http.getJson("qq", "https://example.test/auth", {
      cacheTtlMs: 60000,
      cacheKey: "qq:search:auth",
      getHeaders: async () => { headerReads += 1; return { Cookie: cookie }; }
    });

    await expect(request()).resolves.toEqual({ value: 1 });
    await expect(request()).resolves.toEqual({ value: 1 });
    cookie = "session=second-private-value";
    await expect(request()).resolves.toEqual({ value: 2 });
    expect(headerReads).toBe(3);
    expect(queued.requests).toHaveLength(2);

    const controller = new AbortController();
    controller.abort();
    await expect(http.getJson("qq", "https://example.test/auth", {
      signal: controller.signal,
      cacheTtlMs: 60000,
      cacheKey: "qq:search:auth",
      getHeaders: async () => ({ Cookie: cookie })
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(diagnostics.join(" ")).not.toMatch(/first-private|second-private|[a-f0-9]{64}/i);
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

    let clearCount = 0;
    registerIpcHandlers({
      ipcMain: { handle(channel, listener) { handlers.set(channel, listener); } },
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      cookieStore: { set: async () => undefined, redacted: async () => "configured" },
      metadataAdapters: adapters,
      clearOnlineCache: () => { clearCount += 1; }
    });

    await expect(handlers.get(ipcChannels.searchMetadata)?.({}, "netease", "Found")).resolves.toEqual([candidate]);
    await expect(handlers.get(ipcChannels.testProviderCookie)?.({}, "netease")).resolves.toEqual({ ok: true, status: "configured" });
    await expect(handlers.get(ipcChannels.clearOnlineCache)?.({})).resolves.toBeUndefined();
    expect(clearCount).toBe(1);
    expect(JSON.stringify(await handlers.get(ipcChannels.testProviderCookie)?.({}, "netease"))).not.toContain("Cookie");
  });
});
