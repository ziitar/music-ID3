import type { CoverArt, MetadataCandidate } from "../../../shared/types";
import type { HttpClient } from "./http-client";
import { HttpRequestError } from "./http-client";
import type { MetadataAdapter } from "./adapter";
import { toCtdbToc } from "./ctdb-adapter";

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
const defaultUserAgent = "MusicID3Desktop/1.0 (https://github.com/uziit/music-ID3)";
const coverMaxBytes = 20 * 1024 * 1024;

function isSafeCoverUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLocaleLowerCase("en-US");
    return url.protocol === "https:" && url.port === "" && url.username === "" && url.password === "" && (
      host === "coverartarchive.org" ||
      host === "archive.org" ||
      host.endsWith(".archive.org")
    );
  } catch {
    return false;
  }
}

function safeCoverUrl(value: string): string {
  if (!isSafeCoverUrl(value)) throw new TypeError("Invalid Cover Art Archive cover URL");
  return new URL(value).toString();
}

function creditName(credits: ArtistCredit | undefined): string | undefined {
  if (!credits?.length) return undefined;
  const value = credits.map((credit) => `${credit.name ?? credit.artist?.name ?? ""}${credit.joinphrase ?? ""}`).join("").trim();
  return value || undefined;
}

function mediumCandidates(release: MusicBrainzRelease): MetadataCandidate[] {
  const media = release.media?.length ? release.media : [{}];
  const releaseArtist = creditName(release["artist-credit"]);
  return media.map((medium, mediumIndex) => {
    const mediumPosition = medium.position ?? mediumIndex + 1;
    const sourceTracks = medium.tracks ?? medium.track ?? [];
    const discs = (medium.discs ?? []).filter((disc) => Boolean(disc.id));
    const primaryDisc = discs[0];
    const offsets = primaryDisc?.offsets;
    const tracks = sourceTracks.map((track, index) => ({
      number: track.position ?? (Number.parseInt(track.number ?? "", 10) || index + 1),
      title: track.title ?? track.recording?.title ?? `Track ${index + 1}`,
      artist: creditName(track["artist-credit"] ?? track.recording?.["artist-credit"]) ?? releaseArtist,
      ...(track.length !== undefined ? { durationMs: track.length } : {})
    }));
    const totalDurationMs = tracks.length > 0 && tracks.every((track) => track.durationMs !== undefined)
      ? tracks.reduce((total, track) => total + (track.durationMs ?? 0), 0)
      : undefined;
    const evidence = [
      release.country && `Country: ${release.country}`,
      medium.format && `Format: ${medium.format}`,
      media.length > 1 && `Disc ${mediumPosition} of ${media.length}`,
      primaryDisc?.id && "MusicBrainz Disc ID available"
    ].filter((value): value is string => Boolean(value));
    return {
      id: media.length > 1 ? `${release.id}#medium=${mediumPosition}` : release.id,
      releaseId: release.id,
      ...(release.media?.length ? { mediumPosition, mediumCount: media.length } : {}),
      source: "musicbrainz" as const,
      title: release.title,
      album: release.title,
      artist: releaseArtist,
      albumArtist: releaseArtist,
      date: release.date,
      country: release.country,
      format: medium.format,
      trackCount: medium["track-count"] ?? (sourceTracks.length || (media.length === 1 ? release["track-count"] : undefined)),
      trackTotal: medium["track-count"] ?? (sourceTracks.length || (media.length === 1 ? release["track-count"] : undefined)),
      discNumber: release.media?.length ? mediumPosition : undefined,
      discTotal: release.media?.length ? media.length : undefined,
      tracks: tracks.length ? tracks : undefined,
      totalDurationMs,
      discId: primaryDisc?.id,
      discIds: discs.map((disc) => disc.id as string),
      offsets,
      toc: offsets?.length && primaryDisc?.sectors !== undefined ? toCtdbToc({ offsets, sectors: primaryDisc.sectors }) : undefined,
      confidence: "low" as const,
      evidence
    };
  });
}

function releaseIdFromCandidateId(id: string): { releaseId: string; mediumPosition?: number } {
  const match = id.match(/^(.*)#medium=(\d+)$/);
  return match ? { releaseId: match[1], mediumPosition: Number(match[2]) } : { releaseId: id };
}

export function createMusicBrainzAdapter(options: { http: HttpClient; userAgent?: string }): MetadataAdapter {
  const headers = { Accept: "application/json", "User-Agent": options.userAgent ?? defaultUserAgent };
  const cacheTtlMs = 15 * 60 * 1000;

  return {
    async search(query) {
      const url = `${musicBrainzBase}/release/?query=${encodeURIComponent(query)}&fmt=json&limit=25`;
      const result = await options.http.getJson<{ releases?: MusicBrainzRelease[] }>("musicbrainz", url, { headers, cacheTtlMs });
      return (result.releases ?? []).flatMap(mediumCandidates);
    },

    async getDetails(id) {
      const include = encodeURIComponent("artist-credits+media+discids+recordings");
      const requested = releaseIdFromCandidateId(id);
      const release = await options.http.getJson<MusicBrainzRelease>(
        "musicbrainz",
        `${musicBrainzBase}/release/${encodeURIComponent(requested.releaseId)}?inc=${include}&fmt=json`,
        { headers, cacheTtlMs }
      );
      const candidates = mediumCandidates(release);
      return requested.mediumPosition === undefined
        ? candidates[0]
        : candidates.find((candidate) => candidate.mediumPosition === requested.mediumPosition) ?? (() => { throw new Error("MusicBrainz medium was not found in the release"); })();
    },

    async getCover(candidate): Promise<CoverArt | undefined> {
      try {
        const listing = await options.http.getJson<{
          images?: Array<{ front?: boolean; approved?: boolean; image?: string; thumbnails?: Record<string, string> }>;
        }>("musicbrainz", `${coverArtBase}/release/${encodeURIComponent(candidate.releaseId ?? releaseIdFromCandidateId(candidate.id).releaseId)}`, { headers, cacheTtlMs });
        const front = listing.images?.find((image) => image.front && image.approved !== false);
        const coverUrl = front?.thumbnails?.["500"] ?? front?.thumbnails?.large ?? front?.image;
        if (!coverUrl) return undefined;
        const cover = await options.http.getBytes("musicbrainz", safeCoverUrl(coverUrl), {
          headers,
          cacheTtlMs,
          cacheKey: `musicbrainz:cover:${coverUrl}`,
          maxResponseBytes: coverMaxBytes,
          validateRedirectUrl: isSafeCoverUrl
        });
        return { mimeType: cover.mimeType, data: Buffer.from(cover.data).toString("base64") };
      } catch (error) {
        if (error instanceof HttpRequestError && error.status === 404) return undefined;
        throw error;
      }
    }
  };
}
