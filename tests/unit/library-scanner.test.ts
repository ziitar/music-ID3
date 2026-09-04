import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isSupportedAudioPath, isSuspectedWholeTrack, wholeTrackStatus } from "../../electron/services/audio-format";
import { createLibraryScanner, scanDirectory } from "../../electron/services/library-scanner";
import type { AudioMetadata } from "../../shared/types";

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
  it("stops reading and emitting when its abort signal is cancelled", async () => {
    const controller = new AbortController();
    const emitted: string[] = [];
    const scanner = createLibraryScanner({
      readdir: async () => [{ name: "one.flac", isDirectory: () => false, isFile: () => true }, { name: "two.flac", isDirectory: () => false, isFile: () => true }] as never,
      readAudioMetadata: async (filePath) => { controller.abort(); return { common: {}, raw: {}, durationMs: filePath.includes("one") ? 1 : 2 }; },
      stat: async () => ({ size: 1 }) as never
    });
    await scanner.scanDirectory("D:/Music", (item) => emitted.push(item.path), controller.signal);
    expect(emitted.length).toBeLessThanOrEqual(1);
  });
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

  it("decodes structured CUE items and retains an item-level parse error", async () => {
    const root = await createTempDir();
    const validCuePath = path.join(root, "valid.cue");
    const brokenCuePath = path.join(root, "broken.cue");
    await writeFile(validCuePath, Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('TITLE "Album"\nFILE "disc.flac" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00')
    ]));
    await writeFile(brokenCuePath, [
      'FILE "disc.flac" WAVE',
      "  TRACK 01 AUDIO",
      "    INDEX 01 00:00:00",
      "  TRACK 02 AUDIO",
      '    TITLE "Dangling"'
    ].join("\n"));

    const summary = await scanDirectory(root, () => undefined);
    const valid = summary.items.find((item) => item.kind === "cue" && item.path === validCuePath);
    const broken = summary.items.find((item) => item.kind === "cue" && item.path === brokenCuePath);

    expect(valid).toMatchObject({
      kind: "cue",
      encoding: "utf8-bom",
      parsed: { title: "Album", tracks: [{ number: 1 }] }
    });
    expect(broken).toMatchObject({
      kind: "cue",
      path: brokenCuePath,
      rawText: expect.stringContaining("TRACK 02 AUDIO"),
      parseError: expect.stringMatching(/TRACK 02.*INDEX 01/i)
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

  it("keeps separate CUE files and associates every FILE in a multi-FILE CUE", async () => {
    const root = await createTempDir();
    const firstAudio = path.join(root, "first.mp3");
    const secondAudio = path.join(root, "second.flac");
    const firstCue = path.join(root, "first.cue");
    const secondCue = path.join(root, "second.cue");
    await Promise.all([writeFile(firstAudio, "bad"), writeFile(secondAudio, "bad")]);
    await writeFile(firstCue, [
      'FILE "first.mp3" WAVE',
      "  TRACK 01 AUDIO",
      "    INDEX 01 00:00:00",
      'FILE "second.flac" WAVE',
      "  TRACK 02 AUDIO",
      "    INDEX 01 00:00:00"
    ].join("\n"));
    await writeFile(secondCue, [
      'FILE "second.flac" WAVE',
      "  TRACK 01 AUDIO",
      "    INDEX 01 00:00:00"
    ].join("\n"));

    const summary = await scanDirectory(root, () => undefined);
    const firstCueItem = summary.items.find((item) => item.kind === "cue" && item.path === firstCue);
    const secondCueItem = summary.items.find((item) => item.kind === "cue" && item.path === secondCue);
    const firstAudioItem = summary.items.find((item) => item.kind === "audio" && item.path === firstAudio);
    const secondAudioItem = summary.items.find((item) => item.kind === "audio" && item.path === secondAudio);

    expect(firstCueItem).toMatchObject({ referencedFiles: [firstAudio, secondAudio] });
    expect(secondCueItem).toMatchObject({ referencedFiles: [secondAudio] });
    expect(firstAudioItem).toMatchObject({ cuePath: firstCue });
    expect(secondAudioItem).toMatchObject({ cuePath: secondCue });
  });

  it("emits an early item while a later metadata read remains pending", async () => {
    const root = await createTempDir();
    const earlyPath = path.join(root, "early.mp3");
    const slowPath = path.join(root, "slow.mp3");
    await Promise.all([writeFile(earlyPath, "bad"), writeFile(slowPath, "bad")]);
    let releaseSlowRead!: () => void;
    const slowRead = new Promise<void>((resolve) => { releaseSlowRead = resolve; });
    const scanner = createLibraryScanner({
      readAudioMetadata: async (filePath): Promise<AudioMetadata> => {
        if (filePath === slowPath) {
          await slowRead;
        }
        return { common: {}, raw: {}, durationMs: 0, format: "mp3" };
      }
    });
    let firstEmission!: (path: string) => void;
    const emittedFirst = new Promise<string>((resolve) => { firstEmission = resolve; });
    const scan = scanner.scanDirectory(root, (item) => firstEmission(item.path));

    await expect(emittedFirst).resolves.toBe(earlyPath);
    releaseSlowRead();
    await scan;
  });

  it("keeps scanned items when a nested directory read or an item stat fails", async () => {
    const root = await createTempDir();
    const blockedDirectory = path.join(root, "blocked");
    const goodPath = path.join(root, "good.mp3");
    const statFailurePath = path.join(root, "stat-failure.mp3");
    await mkdir(blockedDirectory);
    await Promise.all([writeFile(goodPath, "bad"), writeFile(statFailurePath, "bad")]);
    const scanner = createLibraryScanner({
      readdir: async (directory, options) => {
        if (directory === blockedDirectory) {
          throw new Error("access denied");
        }
        return readdir(directory, options);
      },
      stat: async (filePath) => {
        if (filePath === statFailurePath) {
          throw new Error("stat denied");
        }
        return stat(filePath);
      },
      readAudioMetadata: async (filePath) => filePath === goodPath
        ? { common: {}, raw: {}, durationMs: 0, format: "mp3" }
        : Promise.reject(new Error("metadata denied"))
    });

    const summary = await scanner.scanDirectory(root, () => undefined);

    expect(summary.items.map((item) => item.path)).toEqual([goodPath, statFailurePath]);
    expect(summary.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: blockedDirectory, error: "access denied" }),
      expect.objectContaining({ path: statFailurePath, error: "stat denied" }),
      expect.objectContaining({ path: statFailurePath, error: "metadata denied" })
    ]));
    expect(summary.items.find((item) => item.kind === "audio" && item.path === statFailurePath)).toMatchObject({
      sizeBytes: 0,
      metadata: { errors: ["metadata denied", "stat denied"] }
    });
  });
});
