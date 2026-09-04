import { constants, createCipheriv, createHash, publicEncrypt, randomBytes as nodeRandomBytes } from "node:crypto";
import type { CookieStore } from "../cookie-store";
import type { MetadataCandidate } from "../../../shared/types";
import type { MetadataAdapter } from "./adapter";
import type { HttpClient } from "./http-client";

type NeteaseSong = {
  id: number | string;
  name?: string;
  duration?: number;
  dt?: number;
  artists?: Array<{ name?: string }>;
  ar?: Array<{ name?: string }>;
  album?: { name?: string; picUrl?: string };
  al?: { name?: string; picUrl?: string };
};

const musicDomain = "https://music.163.com";
const eapiDomain = "https://interfacepc.music.163.com";
const sessionCacheTtlMs = 5 * 60 * 1000;
const coverMaxBytes = 20 * 1024 * 1024;
const aesIv = Buffer.from("0102030405060708");
const eapiKey = Buffer.from("e82ckenh8dichen8");
const weapiPresetKey = Buffer.from("0CoJUm6Qyw8W8jud");
const base62 = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const weapiPublicKey = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`;

function encryptAes(text: string, key: Buffer, mode: "ecb" | "cbc", output: "hex" | "base64"): string {
  const cipher = createCipheriv(`aes-128-${mode}`, key, mode === "cbc" ? aesIv : null);
  return Buffer.concat([cipher.update(text, "utf8"), cipher.final()]).toString(output);
}

function encryptEapi(path: string, data: Record<string, unknown>): string {
  const text = JSON.stringify(data);
  const digest = createHash("md5").update(`nobody${path}use${text}md5forencrypt`).digest("hex");
  return encryptAes(`${path}-36cd479b6b5-${text}-36cd479b6b5-${digest}`, eapiKey, "ecb", "hex").toUpperCase();
}

function encryptWeapi(data: Record<string, unknown>, randomBytes: (size: number) => Buffer): { params: string; encSecKey: string } {
  const secretKey = [...randomBytes(16)].map((value) => base62[value % base62.length]).join("");
  const firstLayer = encryptAes(JSON.stringify(data), weapiPresetKey, "cbc", "base64");
  const params = encryptAes(firstLayer, Buffer.from(secretKey), "cbc", "base64");
  const paddedSecret = Buffer.alloc(128);
  Buffer.from(secretKey.split("").reverse().join("")).copy(paddedSecret, 128 - secretKey.length);
  const encSecKey = publicEncrypt({ key: weapiPublicKey, padding: constants.RSA_NO_PADDING }, paddedSecret).toString("hex");
  return { params, encSecKey };
}

function cookieValues(cookie: string | undefined): Record<string, string> {
  return Object.fromEntries((cookie ?? "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const separator = part.indexOf("=");
    return separator < 0 ? [part, ""] : [part.slice(0, separator), part.slice(separator + 1)];
  }));
}

function safeCoverUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || !/^p\d+\.music\.126\.net$/i.test(url.hostname)) {
    throw new TypeError("Invalid NetEase cover URL");
  }
  return url.toString();
}

function mapSong(song: NeteaseSong): MetadataCandidate {
  const artists = song.artists ?? song.ar ?? [];
  const album = song.album ?? song.al;
  return {
    id: String(song.id),
    source: "netease",
    title: song.name ?? `Song ${song.id}`,
    artist: artists.map((artist) => artist.name).filter(Boolean).join(" / ") || undefined,
    album: album?.name,
    totalDurationMs: song.duration ?? song.dt,
    coverUrl: album?.picUrl,
    confidence: "low",
    evidence: ["NetEase song result"]
  };
}

export function createNeteaseAdapter(options: {
  http: HttpClient;
  cookieStore: Pick<CookieStore, "get">;
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
}): MetadataAdapter {
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? nodeRandomBytes;

  async function search(query: string): Promise<MetadataCandidate[]> {
    const cookie = await options.cookieStore.get("netease");
    const values = cookieValues(cookie);
    const timestamp = now();
    const header = {
      osver: values.osver ?? "Microsoft-Windows-10-Professional-build-19045-64bit",
      deviceId: values.deviceId ?? "",
      os: values.os ?? "pc",
      appver: values.appver ?? "3.1.17.204416",
      versioncode: values.versioncode ?? "140",
      buildver: values.buildver ?? String(timestamp).slice(0, 10),
      resolution: values.resolution ?? "1920x1080",
      __csrf: values.__csrf ?? "",
      channel: values.channel ?? "netease",
      requestId: `${timestamp}_${String(randomBytes(2).readUInt16BE() % 1000).padStart(4, "0")}`,
      ...(values.MUSIC_U ? { MUSIC_U: values.MUSIC_U } : {}),
      ...(values.MUSIC_A ? { MUSIC_A: values.MUSIC_A } : {}),
      ...(values.NMTID ? { NMTID: values.NMTID } : {})
    };
    const data = { s: query, type: 1, limit: 30, offset: 0, e_r: false, header };
    const body = new URLSearchParams({ params: encryptEapi("/api/search/get", data) });
    const result = await options.http.postJson<{ result?: { songs?: NeteaseSong[] } }>(
      "netease",
      `${eapiDomain}/eapi/search/get`,
      {
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "User-Agent": "NeteaseMusic/9.0.90/5038 (iPhone; iOS 16.2; zh_CN)",
          ...(cookie ? { Cookie: cookie } : {})
        },
        body: body.toString(),
        cacheTtlMs: sessionCacheTtlMs,
        cacheKey: `netease:search:${query}`
      }
    );
    return (result.result?.songs ?? []).map(mapSong);
  }

  return {
    search,

    async getDetails(id) {
      const cookie = await options.cookieStore.get("netease");
      const c = JSON.stringify([{ id: Number.isFinite(Number(id)) ? Number(id) : id }]);
      const encrypted = encryptWeapi({ c, e_r: false, csrf_token: cookieValues(cookie).__csrf ?? "" }, randomBytes);
      const body = new URLSearchParams(encrypted);
      const result = await options.http.postJson<{ songs?: NeteaseSong[] }>(
        "netease",
        `${musicDomain}/weapi/v3/song/detail`,
        {
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            Referer: musicDomain,
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
            ...(cookie ? { Cookie: cookie } : {})
          },
          body: body.toString(),
          cacheTtlMs: sessionCacheTtlMs,
          cacheKey: `netease:details:${id}`
        }
      );
      const song = result.songs?.[0];
      if (!song) throw new Error("NetEase returned no song details");
      return mapSong(song);
    },

    async getCover(candidate) {
      if (!candidate.coverUrl) return undefined;
      const result = await options.http.getBytes("netease", safeCoverUrl(candidate.coverUrl), {
        headers: { Accept: "image/*", Referer: "https://music.163.com/" },
        maxResponseBytes: coverMaxBytes,
        cacheTtlMs: sessionCacheTtlMs,
        cacheKey: `netease:cover:${candidate.coverUrl}`
      });
      return { mimeType: result.mimeType, data: Buffer.from(result.data).toString("base64") };
    },

    async testConnection() {
      await search("test");
    }
  };
}
