import type { CoverArt, MetadataCandidate } from "../../../shared/types";
import type { HttpClient } from "./http-client";
import { HttpRequestError } from "./http-client";
import type { MetadataAdapter } from "./adapter";

type ArtistCredit = Array<{ name?: string; joinphrase?: string; artist?: { name?: string } }>;
type MusicBrainzTrack = {
  position?: number;
  number?: string;
  title?: string;
  length?: number;
  "artist-credit"?: ArtistCredit;
  recording?: { title?: string; "artist-credit"?: ArtistCredit };
};
type MusicBrainzMedium = {
  position?: number;
  format?: string;
  "track-count"?: number;
  tracks?: MusicBrainzTrack[];
  track?: MusicBrainzTrack[];
  discs?: Array<{ id?: string; sectors?: number; offsets?: number[] }>;
};
type MusicBrainzRelease = {
  id: string;
  title: string;
  date?: string;
  country?: string;
  "artist-credit"?: ArtistCredit;
  "track-count"?: number;
  media?: MusicBrainzMedium[];
};

const musicBrainzBase = "https://musicbrainz.org/ws/2";
const coverArtBase = "https://coverartarchive.org";

function creditName(credits: ArtistCredit | undefined): string | undefined {
  if (!credits?.length) return undefined;
  const value = credits.map((credit) => `${credit.name ?? credit.artist?.name ?? ""}${credit.joinphrase ?? ""}`).join("").trim();
  return value || undefined;
}

function releaseCandidate(release: MusicBrainzRelease): MetadataCandidate {
  const media = release.media ?? [];
  const allTracks = media.flatMap((medium) => medium.tracks ?? medium.track ?? []);
  const releaseArtist = creditName(release["artist-credit"]);
  const discs = media.flatMap((medium) => medium.discs ?? []).filter((disc) => Boolean(disc.id));
  const primaryDisc = discs[0];
  const offsets = primaryDisc?.offsets;
  const formats = [...new Set(media.map((medium) => medium.format).filter((format): format is string => Boolean(format)))];
  const tracks = allTracks.map((track, index) => ({
    number: track.position ?? (Number.parseInt(track.number ?? "", 10) || index + 1),
    title: track.title ?? track.recording?.title ?? `Track ${index + 1}`,
    artist: creditName(track["artist-credit"] ?? track.recording?.["artist-credit"]) ?? releaseArtist,
    ...(track.length !== undefined ? { durationMs: track.length } : {})
  }));
  const totalDurationMs = tracks.every((track) => track.durationMs !== undefined)
    ? tracks.reduce((total, track) => total + (track.durationMs ?? 0), 0)
    : undefined;
  const evidence = [release.country && `Country: ${release.country}`, formats.length && `Format: ${formats.join(", ")}`, primaryDisc?.id && "MusicBrainz Disc ID available"]
    .filter((value): value is string => Boolean(value));

  return {
    id: release.id,
    source: "musicbrainz",
    title: release.title,
    album: release.title,
    artist: releaseArtist,
    date: release.date,
    country: release.country,
    format: formats.join(", ") || undefined,
    trackCount: release["track-count"] ?? (allTracks.length || media.reduce((total, medium) => total + (medium["track-count"] ?? 0), 0) || undefined),
    tracks: tracks.length ? tracks : undefined,
    totalDurationMs,
    discId: primaryDisc?.id,
    discIds: discs.map((disc) => disc.id as string),
    offsets,
    toc: offsets?.length && primaryDisc?.sectors !== undefined ? `0+${[...offsets, primaryDisc.sectors].join("+")}` : undefined,
    confidence: "low",
    evidence
  };
}

export function createMusicBrainzAdapter(options: { http: HttpClient; userAgent: string }): MetadataAdapter {
  const headers = { Accept: "application/json", "User-Agent": options.userAgent };
  const cacheTtlMs = 15 * 60 * 1000;

  return {
    async search(query) {
      const url = `${musicBrainzBase}/release/?query=${encodeURIComponent(query)}&fmt=json&limit=25`;
      const result = await options.http.getJson<{ releases?: MusicBrainzRelease[] }>("musicbrainz", url, { headers, cacheTtlMs });
      return (result.releases ?? []).map(releaseCandidate);
    },

    async getDetails(id) {
      const include = encodeURIComponent("artist-credits+media+discids+recordings");
      const release = await options.http.getJson<MusicBrainzRelease>(
        "musicbrainz",
        `${musicBrainzBase}/release/${encodeURIComponent(id)}?inc=${include}&fmt=json`,
        { headers, cacheTtlMs }
      );
      return releaseCandidate(release);
    },

    async getCover(candidate): Promise<CoverArt | undefined> {
      try {
        const listing = await options.http.getJson<{
          images?: Array<{ front?: boolean; approved?: boolean; image?: string; thumbnails?: Record<string, string> }>;
        }>("musicbrainz", `${coverArtBase}/release/${encodeURIComponent(candidate.id)}`, { headers, cacheTtlMs });
        const front = listing.images?.find((image) => image.front && image.approved !== false);
        const coverUrl = front?.thumbnails?.["500"] ?? front?.thumbnails?.large ?? front?.image;
        if (!coverUrl) return undefined;
        const cover = await options.http.getBytes("musicbrainz", coverUrl, { headers, cacheTtlMs });
        return { mimeType: cover.mimeType, data: Buffer.from(cover.data).toString("base64") };
      } catch (error) {
        if (error instanceof HttpRequestError && error.status === 404) return undefined;
        throw error;
      }
    }
  };
}
