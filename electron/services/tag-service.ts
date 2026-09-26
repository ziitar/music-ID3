import path from "node:path";
import {
  ApeTag,
  ApeTagItemType,
  ByteVector,
  File as TagLibFile,
  Id3v2CommentsFrame,
  Id3v2TextInformationFrame,
  Id3v2UnsynchronizedLyricsFrame,
  Id3v2UserTextInformationFrame,
  Mpeg4AppleAdditionalInfoBox,
  Mpeg4AppleDataBox,
  Mpeg4AppleItemListBox,
  Mpeg4AppleTag,
  Mpeg4BoxType,
  Picture,
  StringType,
  TagTypes,
  XiphComment,
  type Id3v2Tag,
  type Tag
} from "node-taglib-sharp";
import type { AudioMetadata, CommonMetadata, CoverArt, MetadataPatch, WriteResult } from "../../shared/types";

type MetadataField = keyof CommonMetadata;

type TagLibHandle = {
  tag: Tag;
  properties: { durationMilliseconds: number; codecs: Array<{ description: string }> };
  getTag?(type: TagTypes, create: boolean): Tag;
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

function extensionFor(filePath: string): string {
  return path.extname(filePath).slice(1).toLowerCase();
}

function fieldsSupportedBy(format: string): readonly MetadataField[] {
  if (format === "wv") {
    return [];
  }
  return allCommonFields;
}

function addRawValue(raw: AudioMetadata["raw"], key: string, values: string[]): void {
  const textValues = values.filter((value) => value !== "");
  if (textValues.length === 0) {
    return;
  }
  const previous = raw[key];
  raw[key] = previous === undefined
    ? textValues.length === 1 ? textValues[0] : textValues
    : [...(Array.isArray(previous) ? previous : [previous]), ...textValues];
}

function concreteTag(handle: TagLibHandle, type: TagTypes): Tag | undefined {
  const fileTag = handle.getTag?.(type, false);
  if (fileTag) {
    return fileTag;
  }
  const combinedTag = handle.tag as Tag & { getTag?: (tagType: TagTypes) => Tag };
  const nestedTag = typeof combinedTag.getTag === "function" ? combinedTag.getTag(type) : undefined;
  return nestedTag ?? (handle.tag.tagTypes === type ? handle.tag : undefined);
}

function appleRawItemList(tag: Mpeg4AppleTag): Mpeg4AppleItemListBox | undefined {
  return (tag as unknown as { _ilstBox?: Mpeg4AppleItemListBox })._ilstBox;
}

function isAppleRawItemList(value: unknown): value is Mpeg4AppleItemListBox {
  return typeof value === "object" && value !== null && Array.isArray((value as { children?: unknown }).children);
}

function extractAppleRawTags(raw: AudioMetadata["raw"], tag: Mpeg4AppleTag): void {
  try {
    const itemList = appleRawItemList(tag);
    if (!isAppleRawItemList(itemList)) {
      return;
    }
    for (const atom of itemList.children) {
      const atomType = atom.boxType.toString(StringType.Latin1);
      const dataBoxes = atom.getChildren<Mpeg4AppleDataBox>(Mpeg4BoxType.DATA);
      const text = dataBoxes.map((box) => box.text).filter((value): value is string => value !== undefined);
      if (atomType === "----") {
        const mean = atom.getChild<Mpeg4AppleAdditionalInfoBox>(Mpeg4BoxType.MEAN)?.text;
        const name = atom.getChild<Mpeg4AppleAdditionalInfoBox>(Mpeg4BoxType.NAME)?.text;
        if (mean && name) {
          addRawValue(raw, `MP4:----:${mean}:${name}`, text);
        }
      } else {
        addRawValue(raw, `MP4:${atomType}`, text);
      }
    }
  } catch {
    // Raw Apple atoms depend on private wrapper structures; common metadata remains authoritative.
  }
}

function extractRawTags(handle: TagLibHandle): AudioMetadata["raw"] {
  const raw: AudioMetadata["raw"] = {};
  const id3 = concreteTag(handle, TagTypes.Id3v2) as Id3v2Tag | undefined;
  if (id3) {
    for (const frame of id3.frames) {
      if (frame instanceof Id3v2UserTextInformationFrame) {
        addRawValue(raw, `TXXX:${frame.description}`, frame.text);
      } else if (frame instanceof Id3v2CommentsFrame) {
        addRawValue(raw, `COMM:${frame.language}:${frame.description}`, [frame.text]);
      } else if (frame instanceof Id3v2UnsynchronizedLyricsFrame) {
        addRawValue(raw, `USLT:${frame.language}:${frame.description}`, [frame.text]);
      } else if (frame instanceof Id3v2TextInformationFrame) {
        addRawValue(raw, frame.frameId.toString(), frame.text);
      }
    }
  }

  const apple = concreteTag(handle, TagTypes.Apple) as Mpeg4AppleTag | undefined;
  if (apple) {
    extractAppleRawTags(raw, apple);
  }

  const xiph = concreteTag(handle, TagTypes.Xiph) as XiphComment | undefined;
  if (xiph) {
    for (const key of xiph.fieldNames) {
      if (key !== "METADATA_BLOCK_PICTURE" && key !== "COVERART") {
        addRawValue(raw, key, xiph.getField(key));
      }
    }
  }

  const ape = concreteTag(handle, TagTypes.Ape) as ApeTag | undefined;
  if (ape) {
    for (const item of ape.items) {
      if (item.type === ApeTagItemType.Text) {
        addRawValue(raw, item.key, item.text);
      }
    }
  }
  return raw;
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
    albumArtist: tag.albumArtists?.filter(Boolean).join(" / ") || undefined,
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
  return {
    common,
    raw: extractRawTags(handle),
    durationMs: Math.round(handle.properties?.durationMilliseconds ?? 0),
    format,
  };
}

function validatePatch(patch: MetadataPatch): WriteResult | undefined {
  for (const field of patch.selectedFields) {
    const value = patch.fields[field];
    if (value === undefined || field === "cover" || (Array.isArray(value) && value.length === 0)) continue;
    if (["trackNumber", "trackTotal", "discNumber", "discTotal"].includes(field)) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return { ok: false, error: `Invalid ${field} value`, unsupportedFields: [field] };
    } else if (typeof value !== "string") {
      return { ok: false, error: `Invalid ${field} value`, unsupportedFields: [field] };
    }
  }
  if (patch.selectedFields.includes("date") && patch.fields.date !== undefined && !/^\d{4}$/.test(patch.fields.date)) {
    return { ok: false, error: "Date writes require an exact four-digit year", unsupportedFields: ["date"] };
  }
  return undefined;
}

function clearValueMatchesUndefined(value: unknown): boolean {
  return value === "" || value === 0 || (Array.isArray(value) && value.length === 0);
}

function inferredImageMimeType(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return "image/jpeg";
  }
  if (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a") {
    return "image/gif";
  }
  if (bytes.subarray(0, 2).toString("ascii") === "BM") {
    return "image/bmp";
  }
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return undefined;
}

function normalizedCoverMimeType(cover: CoverArt): string {
  const inferred = inferredImageMimeType(Buffer.from(cover.data, "base64"));
  if (inferred) {
    return inferred;
  }
  const declared = cover.mimeType.toLowerCase().split(";", 1)[0].trim();
  return declared === "image/x-png" ? "image/png" : declared === "image/jpg" ? "image/jpeg" : declared;
}

function coversMatch(expected: CoverArt | undefined, actual: CoverArt | undefined): boolean {
  if (!expected || !actual) {
    return expected === actual;
  }
  return Buffer.from(expected.data, "base64").equals(Buffer.from(actual.data, "base64"))
    && normalizedCoverMimeType(expected) === normalizedCoverMimeType(actual);
}

function selectedFieldsMatch(metadata: AudioMetadata, patch: MetadataPatch): MetadataField[] {
  return patch.selectedFields.filter((field) => {
    const expected = patch.fields[field];
    const actual = metadata.common[field];
    if (field === "cover") {
      const expectedCover = expected as CoverArt | undefined;
      const actualCover = actual as CoverArt | undefined;
      return !coversMatch(expectedCover, actualCover);
    }
    return expected !== actual && !(actual === undefined && clearValueMatchesUndefined(expected));
  });
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
    if (patch.selectedFields.length === 0) {
      const metadata = await readAudioMetadata(filePath);
      return metadata.errors?.length
        ? { ok: false, error: metadata.errors.join("; ") }
        : { ok: true, metadata };
    }
    const format = extensionFor(filePath);
    const validationError = validatePatch(patch);
    if (validationError) {
      return validationError;
    }
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
      if (metadata.errors?.length) {
        return { ok: false, error: metadata.errors.join("; ") };
      }
      const mismatchedFields = selectedFieldsMatch(metadata, patch);
      return mismatchedFields.length > 0
        ? { ok: false, error: `Metadata write verification failed for ${mismatchedFields.join(", ")}` }
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
