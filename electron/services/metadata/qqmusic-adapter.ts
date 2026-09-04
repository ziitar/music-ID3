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

function coverUrl(albumMid: string | undefined): string | undefined {
  return albumMid ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumMid}.jpg?max_age=2592000` : undefined;
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
  function requestOptions(): HttpRequestOptions {
    return {
      headers: {
        Accept: "application/json",
        Referer: "https://y.qq.com/"
      },
      getHeaders: async () => {
        const cookie = await options.cookieStore.get("qq");
        const headers: Record<string, string> = {};
        if (cookie) headers.Cookie = cookie;
        return headers;
      }
    };
  }

  async function search(query: string): Promise<MetadataCandidate[]> {
    const params = new URLSearchParams({
      w: query,
      format: "json",
      outCharset: "utf-8",
      ct: "24",
      qqmusic_ver: "1298",
      remoteplace: "txt.yqq.song",
      t: "0",
      aggr: "1",
      cr: "1",
      lossless: "0",
      flag_qc: "0",
      platform: "yqq.json"
    });
    const result = await options.http.getJson<{
      data?: { song?: { list?: QqSong[] }; songlist?: QqSong[] };
    }>("qq", `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?${params}`, requestOptions());
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
      const params = new URLSearchParams({
        format: "json",
        inCharset: "utf8",
        outCharset: "utf-8",
        notice: "0",
        platform: "yqq.json",
        needNewCode: "0",
        data
      });
      const result = await options.http.getJson<{
        songinfo?: { data?: { track_info: QqSong } | QqSong };
      }>("qq", `https://u.y.qq.com/cgi-bin/musicu.fcg?${params}`, requestOptions());
      const dataResult = result.songinfo?.data;
      const song = dataResult && "track_info" in dataResult ? dataResult.track_info : dataResult;
      if (!song) throw new Error("QQ Music returned no song details");
      return mapSong(song);
    },

    async getCover(candidate) {
      if (!candidate.coverUrl) return undefined;
      const result = await options.http.getBytes("qq", candidate.coverUrl, requestOptions());
      return { mimeType: result.mimeType, data: Buffer.from(result.data).toString("base64") };
    },

    async testConnection() {
      await search("test");
    }
  };
}
