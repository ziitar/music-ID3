import type { CookieStore } from "../cookie-store";
import type { MetadataCandidate } from "../../../shared/types";
import type { MetadataAdapter } from "./adapter";
import type { HttpClient, HttpRequestOptions } from "./http-client";

type QqSong = {
  songid?: number;
  id?: number;
  songmid?: string;
  mid?: string;
  songname?: string;
  name?: string;
  interval?: number;
  albummid?: string;
  albumname?: string;
  album?: { mid?: string; name?: string };
  singer?: Array<{ name?: string }>;
};

const sessionCacheTtlMs = 5 * 60 * 1000;
const coverMaxBytes = 20 * 1024 * 1024;

function cookieValues(cookie: string | undefined): Record<string, string> {
  return Object.fromEntries((cookie ?? "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const separator = part.indexOf("=");
    return separator < 0 ? [part, ""] : [part.slice(0, separator), part.slice(separator + 1)];
  }));
}

function commonParams(cookie: string | undefined): Record<string, string> {
  return {
    g_tk: "1124214810",
    loginUin: cookieValues(cookie).uin ?? "0",
    hostUin: "0",
    inCharset: "utf8",
    outCharset: "utf-8",
    notice: "0",
    platform: "yqq.json",
    needNewCode: "0"
  };
}

function coverUrl(albumMid: string | undefined): string | undefined {
  return albumMid ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumMid}.jpg?max_age=2592000` : undefined;
}

function isSafeCoverUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.port === "" && url.username === "" && url.password === "" && url.hostname.toLocaleLowerCase("en-US") === "y.gtimg.cn";
  } catch {
    return false;
  }
}

function safeCoverUrl(value: string): string {
  if (!isSafeCoverUrl(value)) {
    throw new TypeError("Invalid QQ Music cover URL");
  }
  return new URL(value).toString();
}

function mapSong(song: QqSong): MetadataCandidate {
  const id = song.songmid ?? song.mid ?? song.songid ?? song.id;
  const albumMid = song.albummid ?? song.album?.mid;
  return {
    id: String(id ?? ""),
    source: "qq",
    title: song.songname ?? song.name ?? `Song ${id ?? ""}`,
    artist: song.singer?.map((artist) => artist.name).filter(Boolean).join(" / ") || undefined,
    album: song.albumname ?? song.album?.name,
    totalDurationMs: song.interval !== undefined ? song.interval * 1000 : undefined,
    coverUrl: coverUrl(albumMid),
    confidence: "low",
    evidence: ["QQ Music song result"]
  };
}

export function createQqMusicAdapter(options: {
  http: HttpClient;
  cookieStore: Pick<CookieStore, "get">;
}): MetadataAdapter {
  function requestOptions(
    cacheKey: string,
    prepare: (cookie: string | undefined) => { url: string; headers: Record<string, string> },
    referrer: string
  ): HttpRequestOptions {
    return {
      headers: { Accept: "application/json" },
      referrer,
      prepareRequest: async () => {
        const cookie = await options.cookieStore.get("qq");
        const prepared = prepare(cookie);
        return {
          ...prepared,
          headers: { ...prepared.headers, ...(cookie ? { Cookie: cookie } : {}) }
        };
      },
      cacheTtlMs: sessionCacheTtlMs,
      cacheKey
    };
  }

  async function search(query: string): Promise<MetadataCandidate[]> {
    const baseUrl = "https://c.y.qq.com/soso/fcgi-bin/client_search_cp";
    const result = await options.http.getJson<{
      data?: { song?: { list?: QqSong[] }; songlist?: QqSong[] };
    }>("qq", baseUrl, requestOptions(`qq:search:${query}`, (cookie) => {
      const params = new URLSearchParams({
        ...commonParams(cookie),
        w: query,
        format: "json",
        ct: "24",
        qqmusic_ver: "1298",
        remoteplace: "txt.yqq.song",
        t: "0",
        aggr: "1",
        cr: "1",
        lossless: "0",
        flag_qc: "0",
        n: "10",
        p: "1",
        catZhida: "1"
      });
      return {
        url: `${baseUrl}?${params}`,
        headers: {}
      };
    }, "https://c.y.qq.com/"));
    return (result.data?.song?.list ?? result.data?.songlist ?? []).map(mapSong);
  }

  return {
    search,

    async getDetails(id) {
      const data = JSON.stringify({
        comm: { ct: 24, cv: 0 },
        songinfo: {
          method: "get_song_detail_yqq",
          param: { song_type: 0, song_mid: id, song_id: "" },
          module: "music.pf_song_detail_svr"
        }
      });
      const baseUrl = "https://u.y.qq.com/cgi-bin/musicu.fcg";
      const result = await options.http.getJson<{
        songinfo?: { data?: { track_info: QqSong } | QqSong };
      }>("qq", baseUrl, requestOptions(`qq:details:${id}`, (cookie) => {
        const params = new URLSearchParams({ ...commonParams(cookie), format: "json", data });
        return {
          url: `${baseUrl}?${params}`,
          headers: {
            "Content-Type": "application/x-www-form-urlencoded"
          }
        };
      }, "https://y.qq.com/portal/player.html"));
      const dataResult = result.songinfo?.data;
      const song = dataResult && "track_info" in dataResult ? dataResult.track_info : dataResult;
      if (!song) throw new Error("QQ Music returned no song details");
      return mapSong(song);
    },

    async getCover(candidate) {
      if (!candidate.coverUrl) return undefined;
      const result = await options.http.getBytes("qq", safeCoverUrl(candidate.coverUrl), {
        headers: { Accept: "image/*" },
        referrer: "https://y.qq.com/",
        maxResponseBytes: coverMaxBytes,
        cacheTtlMs: sessionCacheTtlMs,
        cacheKey: `qq:cover:${candidate.coverUrl}`,
        validateRedirectUrl: isSafeCoverUrl
      });
      return { mimeType: result.mimeType, data: Buffer.from(result.data).toString("base64") };
    },

    async testConnection() {
      await search("test");
    }
  };
}
