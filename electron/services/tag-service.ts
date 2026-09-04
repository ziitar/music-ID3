import path from "node:path";
import { ByteVector, File as TagLibFile, Picture, type Tag } from "node-taglib-sharp";
import type { AudioMetadata, CommonMetadata, CoverArt, MetadataPatch, WriteResult } from "../../shared/types";

type MetadataField = keyof CommonMetadata;

type TagLibHandle = {
  tag: Tag;
  properties: { durationMilliseconds: number; codecs: Array<{ description: string }> };
  save(): void;
  dispose(): void;
};

export type TagLibAdapter = {
  open(filePath: string): TagLibHandle;
};

const tagLibAdapter: TagLibAdapter = {
  open(filePath) {
    return TagLibFile.createFromPath(filePath);
  }
};

const allCommonFields: readonly MetadataField[] = [
  "title", "artist", "albumArtist", "album", "trackNumber", "trackTotal", "discNumber", "discTotal",
  "date", "genre", "composer", "comment", "lyrics", "copyright", "cover"
];

const wavFields: readonly MetadataField[] = ["title", "artist", "album", "genre", "comment", "copyright"];

function extensionFor(filePath: string): string {
  return path.extname(filePath).slice(1).toLowerCase();
}

function fieldsSupportedBy(format: string): readonly MetadataField[] {
  if (format === "wav") {
    return wavFields;
  }
  if (format === "wv") {
    return [];
  }
  return allCommonFields;
}

function first(values: string[] | undefined): string | undefined {
  return values?.[0] || undefined;
}

function positive(value: number): number | undefined {
  return value > 0 ? value : undefined;
}

function mapMetadata(handle: TagLibHandle, format: string): AudioMetadata {
  const tag = handle.tag;
  const cover = tag.pictures[0];
  const common: CommonMetadata = {
    title: tag.title || undefined,
    artist: first(tag.performers),
    albumArtist: first(tag.albumArtists),
    album: tag.album || undefined,
    trackNumber: positive(tag.track),
    trackTotal: positive(tag.trackCount),
    discNumber: positive(tag.disc),
    discTotal: positive(tag.discCount),
    date: positive(tag.year)?.toString(),
    genre: first(tag.genres),
    composer: first(tag.composers),
    comment: tag.comment || undefined,
    lyrics: tag.lyrics || undefined,
    copyright: tag.copyright || undefined,
    cover: cover ? { mimeType: cover.mimeType, data: Buffer.from(cover.data.toByteArray()).toString("base64") } : undefined
  };
  const raw = Object.fromEntries(
    Object.entries(common)
      .filter(([field, value]) => field !== "cover" && value !== undefined && value !== "")
      .map(([field, value]) => [field, typeof value === "number" ? String(value) : value])
  ) as AudioMetadata["raw"];
  return {
    common,
    raw,
    durationMs: Math.round(handle.properties?.durationMilliseconds ?? 0),
    format,
  };
}

function assignField(tag: Tag, field: MetadataField, value: CommonMetadata[MetadataField]): void {
  switch (field) {
    case "title": tag.title = value as string; break;
    case "artist": tag.performers = value ? [value as string] : []; break;
    case "albumArtist": tag.albumArtists = value ? [value as string] : []; break;
    case "album": tag.album = value as string; break;
    case "trackNumber": tag.track = (value as number) || 0; break;
    case "trackTotal": tag.trackCount = (value as number) || 0; break;
    case "discNumber": tag.disc = (value as number) || 0; break;
    case "discTotal": tag.discCount = (value as number) || 0; break;
    case "date": tag.year = value ? Number.parseInt(value as string, 10) || 0 : 0; break;
    case "genre": tag.genres = value ? [value as string] : []; break;
    case "composer": tag.composers = value ? [value as string] : []; break;
    case "comment": tag.comment = value as string; break;
    case "lyrics": tag.lyrics = value as string; break;
    case "copyright": tag.copyright = value as string; break;
    case "cover": {
      const cover = value as CoverArt | undefined;
      tag.pictures = cover
        ? [Picture.fromData(ByteVector.fromByteArray(Buffer.from(cover.data, "base64")))]
        : [];
      break;
    }
  }
}

export function createTagService(adapter: TagLibAdapter = tagLibAdapter) {
  async function readAudioMetadata(filePath: string): Promise<AudioMetadata> {
    const format = extensionFor(filePath);
    try {
      const handle = adapter.open(filePath);
      try {
        return mapMetadata(handle, format);
      } finally {
        handle.dispose();
      }
    } catch (error) {
      return {
        common: {},
        raw: {},
        durationMs: 0,
        format,
        errors: [error instanceof Error ? error.message : String(error)]
      };
    }
  }

  async function writeAudioMetadata(filePath: string, patch: MetadataPatch): Promise<WriteResult> {
    const format = extensionFor(filePath);
    const supportedFields = fieldsSupportedBy(format);
    const unsupportedFields = patch.selectedFields.filter((field) => !supportedFields.includes(field));
    if (unsupportedFields.length > 0) {
      return { ok: false, error: `Unsupported metadata fields for ${format || "unknown format"}`, unsupportedFields };
    }

    try {
      const handle = adapter.open(filePath);
      try {
        for (const field of patch.selectedFields) {
          assignField(handle.tag, field, patch.fields[field]);
        }
        handle.save();
      } finally {
        handle.dispose();
      }
      const metadata = await readAudioMetadata(filePath);
      return metadata.errors?.length
        ? { ok: false, error: metadata.errors.join("; ") }
        : { ok: true, metadata };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return { readAudioMetadata, writeAudioMetadata };
}

const defaultTagService = createTagService();

export const readAudioMetadata = defaultTagService.readAudioMetadata;
export const writeAudioMetadata = defaultTagService.writeAudioMetadata;
