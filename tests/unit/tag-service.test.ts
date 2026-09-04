import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ByteVector,
  File as TagLibFile,
  Id3v2UserTextInformationFrame,
  Picture,
  TagTypes,
  type Id3v2Tag,
  type Tag
} from "node-taglib-sharp";
import { createTagService, readAudioMetadata, writeAudioMetadata } from "../../electron/services/tag-service";

const temporaryDirectories: string[] = [];

function pcmWav(durationMs: number): Buffer {
  const sampleRate = 8_000;
  const channels = 1;
  const bitsPerSample = 8;
  const dataBytes = Math.floor((sampleRate * channels * bitsPerSample / 8) * durationMs / 1_000);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28);
  header.writeUInt16LE(channels * bitsPerSample / 8, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([header, Buffer.alloc(dataBytes)]);
}

async function createFixture(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "music-id3-tag-service-"));
  temporaryDirectories.push(directory);
  const fixturePath = path.join(directory, "fixture.wav");
  await writeFile(fixturePath, pcmWav(1_000));
  return fixturePath;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("tag service", () => {
  it("reads a real supported WAV fixture and verifies selected field writes by rereading", async () => {
    const fixturePath = await createFixture();

    expect(await readAudioMetadata(fixturePath)).toMatchObject({
      durationMs: 1_000,
      format: "wav",
      common: {}
    });

    const result = await writeAudioMetadata(fixturePath, {
      fields: { title: "Scanner fixture" },
      selectedFields: ["title"]
    });

    expect(result).toEqual({
      ok: true,
      metadata: expect.objectContaining({
        format: "wav",
        common: expect.objectContaining({ title: "Scanner fixture" })
      })
    });
    expect((await readAudioMetadata(fixturePath)).common.title).toBe("Scanner fixture");
  });

  it("returns actual multi-value custom ID3v2 raw fields from a real tagged WAV fixture", async () => {
    const fixturePath = await createFixture();
    const file = TagLibFile.createFromPath(fixturePath);
    const id3 = file.getTag(TagTypes.Id3v2, true) as Id3v2Tag;
    const custom = Id3v2UserTextInformationFrame.fromDescription("CATALOG");
    custom.text = ["one", "two"];
    id3.addFrame(custom);
    file.save();
    file.dispose();

    await expect(readAudioMetadata(fixturePath)).resolves.toMatchObject({
      raw: { "TXXX:CATALOG": ["one", "two"] }
    });
  });

  it("supports WAV ID3v2 common fields and cover art", async () => {
    const fixturePath = await createFixture();
    const cover = { mimeType: "image/png", data: "iVBORw0KGgo=" };

    const result = await writeAudioMetadata(fixturePath, {
      fields: {
        title: "ID3 WAV",
        albumArtist: "Album Artist",
        trackNumber: 2,
        trackTotal: 9,
        discNumber: 1,
        discTotal: 2,
        composer: "Composer",
        lyrics: "Words",
        cover
      },
      selectedFields: ["title", "albumArtist", "trackNumber", "trackTotal", "discNumber", "discTotal", "composer", "lyrics", "cover"]
    });

    expect(result).toEqual({
      ok: true,
      metadata: expect.objectContaining({
        common: expect.objectContaining({
          title: "ID3 WAV",
          albumArtist: "Album Artist",
          trackNumber: 2,
          trackTotal: 9,
          discNumber: 1,
          discTotal: 2,
          composer: "Composer",
          lyrics: "Words",
          cover
        })
      })
    });
  });

  it("rejects dates more precise than the year instead of truncating them", async () => {
    const fixturePath = await createFixture();

    await expect(writeAudioMetadata(fixturePath, {
      fields: { date: "2024-05-01" },
      selectedFields: ["date"]
    })).resolves.toEqual({ ok: false, error: expect.stringContaining("four-digit year"), unsupportedFields: ["date"] });
  });

  it("verifies a selected field can be cleared after writing", async () => {
    const fixturePath = await createFixture();
    await writeAudioMetadata(fixturePath, { fields: { title: "Before clear" }, selectedFields: ["title"] });

    await expect(writeAudioMetadata(fixturePath, {
      fields: { title: undefined },
      selectedFields: ["title"]
    })).resolves.toEqual({
      ok: true,
      metadata: expect.objectContaining({ common: expect.objectContaining({ title: undefined }) })
    });
  });

  it("rejects WavPack writes because the installed wrapper has no WavPack implementation", async () => {
    await expect(writeAudioMetadata("not-implemented.wv", {
      fields: { title: "Nope" },
      selectedFields: ["title"]
    })).resolves.toEqual({ ok: false, error: expect.stringContaining("wv"), unsupportedFields: ["title"] });
  });

  it("reports a failed post-write verification when an adapter does not persist a selected field", async () => {
    const tag = () => ({
      title: "Before",
      performers: [],
      albumArtists: [],
      album: undefined,
      track: 0,
      trackCount: 0,
      disc: 0,
      discCount: 0,
      year: 0,
      genres: [],
      composers: [],
      comment: undefined,
      lyrics: undefined,
      copyright: undefined,
      pictures: []
    } as Tag);
    const service = createTagService({
      open: () => ({
        tag: tag(),
        properties: { durationMilliseconds: 1, codecs: [] },
        save: () => undefined,
        dispose: () => undefined
      })
    });

    await expect(service.writeAudioMetadata("no-op.mp3", {
      fields: { title: "After" },
      selectedFields: ["title"]
    })).resolves.toEqual({
      ok: false,
      error: "Metadata write verification failed for title",
      unsupportedFields: ["title"]
    });
  });

  it("extracts a cover from the narrow TagLib adapter boundary", async () => {
    const coverBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const service = createTagService({
      open: () => ({
        tag: { pictures: [Picture.fromData(ByteVector.fromByteArray(coverBytes))] } as Tag,
        properties: { durationMilliseconds: 12, codecs: [] },
        save: () => undefined,
        dispose: () => undefined
      })
    });

    const metadata = await service.readAudioMetadata("fixture.mp3");

    expect(metadata).toMatchObject({
      common: { cover: { mimeType: "image/png", data: coverBytes.toString("base64") } },
      durationMs: 12,
      format: "mp3"
    });
    expect(metadata.raw).not.toHaveProperty("cover");
  });
});
