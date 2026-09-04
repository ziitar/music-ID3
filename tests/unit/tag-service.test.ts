import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ByteVector, Picture, type Tag } from "node-taglib-sharp";
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

  it("reports selected fields unsupported by a format instead of silently dropping them", async () => {
    const fixturePath = await createFixture();

    await expect(writeAudioMetadata(fixturePath, {
      fields: { cover: { mimeType: "image/png", data: "iVBORw0KGgo=" } },
      selectedFields: ["cover"]
    })).resolves.toEqual({ ok: false, error: expect.any(String), unsupportedFields: ["cover"] });
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
