import type { CookieStore } from "../cookie-store";
import type { MetadataCandidate } from "../../../shared/types";
import type { MetadataAdapter } from "./adapter";
import type { HttpClient, HttpRequestOptions } from "./http-client";

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

const baseUrl = "https://music.163.com";

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
}): MetadataAdapter {
  function requestOptions(body?: URLSearchParams): HttpRequestOptions {
    return {
      headers: {
        Accept: "application/json",
        Referer: "https://music.163.com/",
        "User-Agent": "Mozilla/5.0 MusicID3Desktop/1.0",
        ...(body ? { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" } : {})
      },
      getHeaders: async () => {
        const cookie = await options.cookieStore.get("netease");
        const headers: Record<string, string> = {};
        if (cookie) headers.Cookie = cookie;
        return headers;
      },
      ...(body ? { body: body.toString() } : {})
    };
  }

  async function search(query: string): Promise<MetadataCandidate[]> {
    const body = new URLSearchParams({ s: query, type: "1", limit: "30", offset: "0" });
    const result = await options.http.postJson<{ result?: { songs?: NeteaseSong[] } }>(
      "netease",
      `${baseUrl}/api/search/get`,
      requestOptions(body)
    );
    return (result.result?.songs ?? []).map(mapSong);
  }

  return {
    search,

    async getDetails(id) {
      const body = new URLSearchParams({ c: JSON.stringify([{ id: Number.isFinite(Number(id)) ? Number(id) : id }]) });
      const result = await options.http.postJson<{ songs?: NeteaseSong[] }>(
        "netease",
        `${baseUrl}/api/v3/song/detail`,
        requestOptions(body)
      );
      const song = result.songs?.[0];
      if (!song) throw new Error("NetEase returned no song details");
      return mapSong(song);
    },

    async getCover(candidate) {
      if (!candidate.coverUrl) return undefined;
      const result = await options.http.getBytes("netease", candidate.coverUrl, requestOptions());
      return { mimeType: result.mimeType, data: Buffer.from(result.data).toString("base64") };
    },

    async testConnection() {
      await search("test");
    }
  };
}
