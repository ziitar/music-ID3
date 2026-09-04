import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isSupportedAudioPath, isSuspectedWholeTrack, wholeTrackStatus } from "../../electron/services/audio-format";
import { scanDirectory } from "../../electron/services/library-scanner";

const temporaryDirectories: string[] = [];

async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "music-id3-scanner-"));
  temporaryDirectories.push(directory);
  return directory;
}

function pcmWav(durationMs: number): Buffer {
  const dataBytes = Math.floor(8_000 * durationMs / 1_000);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8_000, 24);
  header.writeUInt32LE(8_000, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([header, Buffer.alloc(dataBytes)]);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("audio format helpers", () => {
  it("recognizes configured audio extensions without regard to filename case", () => {
    expect(isSupportedAudioPath("D:/Library/Track.MP3")).toBe(true);
    expect(isSupportedAudioPath("D:/Library/Track.wV")).toBe(true);
    expect(isSupportedAudioPath("D:/Library/cover.jpg")).toBe(false);
  });

  it("only suspects an unassociated file whose duration exceeds fifteen minutes", () => {
    expect(isSuspectedWholeTrack(15 * 60 * 1000, false)).toBe(false);
    expect(isSuspectedWholeTrack(15 * 60 * 1000 + 1, false)).toBe(true);
    expect(isSuspectedWholeTrack(15 * 60 * 1000 + 1, true)).toBe(false);
  });

  it("preserves an explicit whole-track override", () => {
    expect(wholeTrackStatus(15 * 60 * 1000 + 1, false, true)).toBe("overridden");
  });
});

describe("library scanner", () => {
  it("recursively finds mixed-case audio and associates CUE FILE references case-insensitively", async () => {
    const root = await createTempDir();
    const discDirectory = path.join(root, "Disc One");
    await mkdir(discDirectory);
    const audioPath = path.join(discDirectory, "Track.MP3");
    const cuePath = path.join(discDirectory, "Album.CUE");
    await writeFile(audioPath, Buffer.from("not an mp3"));
    await writeFile(path.join(root, "ignore.txt"), "ignore me");
    await writeFile(cuePath, [
      'FILE "track.mp3" WAVE',
      "  TRACK 01 AUDIO",
      '    TITLE "Track"',
      "    INDEX 01 00:00:00"
    ].join("\n"));

    const emitted: string[] = [];
    const summary = await scanDirectory(root, (item) => emitted.push(item.path));
    const audio = summary.items.find((item) => item.kind === "audio");
    const cue = summary.items.find((item) => item.kind === "cue");

    expect(summary.items).toHaveLength(2);
    expect(emitted).toEqual(summary.items.map((item) => item.path));
    expect(audio).toMatchObject({
      kind: "audio",
      path: audioPath,
      extension: ".mp3",
      cuePath,
      wholeTrackStatus: "normal"
    });
    expect(audio?.kind === "audio" && audio.metadata.errors).toHaveLength(1);
    expect(cue).toMatchObject({
      kind: "cue",
      path: cuePath,
      referencedFiles: [audioPath],
      missingReferencedFiles: []
    });
  });

  it("keeps CUE items visible when a referenced relative file is missing", async () => {
    const root = await createTempDir();
    const cuePath = path.join(root, "missing.cue");
    const missingPath = path.join(root, "audio", "Missing.FLAC");
    await writeFile(cuePath, [
      'FILE "audio/Missing.FLAC" WAVE',
      "  TRACK 01 AUDIO",
      "    INDEX 01 00:00:00"
    ].join("\n"));

    const summary = await scanDirectory(root, () => undefined);
    const cue = summary.items.find((item) => item.kind === "cue");

    expect(cue).toMatchObject({
      kind: "cue",
      referencedFiles: [missingPath],
      missingReferencedFiles: [missingPath]
    });
  });

  it("marks an unassociated long WAV as suspected without using its file size as a condition", async () => {
    const root = await createTempDir();
    const audioPath = path.join(root, "long.wav");
    await writeFile(audioPath, pcmWav(15 * 60 * 1000 + 1));

    const summary = await scanDirectory(root, () => undefined);
    const audio = summary.items.find((item) => item.kind === "audio");

    expect(audio).toMatchObject({
      kind: "audio",
      path: audioPath,
      durationMs: 15 * 60 * 1000 + 1,
      wholeTrackStatus: "suspected"
    });
  });
});
