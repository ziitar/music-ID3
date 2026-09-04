import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCueService,
  parseCue,
  readCue,
  serializeCue
} from "../../electron/services/cue-service";
import type { CueDocument } from "../../shared/types";

const temporaryDirectories: string[] = [];

async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "music-id3-cue-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("CUE service", () => {
  it("wraps cue-parser while preserving multi-file structure, gaps, comments, and unknown lines", () => {
    const rawText = [
      "REM DATE 1957",
      "; retained comment",
      'PERFORMER "John Coltrane"',
      'TITLE "Blue Train"',
      'FILE "disc-one.flac" WAVE',
      "  TRACK 01 AUDIO",
      '    TITLE "Blue Train"',
      "    PREGAP 00:00:32",
      "    INDEX 00 00:00:00",
      "    INDEX 01 00:00:32",
      "    POSTGAP 00:00:10",
      'FILE "disc-two.flac" WAVE',
      "  TRACK 02 AUDIO",
      '    TITLE "Moment’s Notice"',
      "    INDEX 01 00:00:00",
      "X-CUSTOM retained-value"
    ].join("\r\n");

    const state = parseCue(rawText, "D:/Music/Blue Train/album.cue");

    expect(state.parseError).toBeUndefined();
    expect(state.parsed).toMatchObject({
      title: "Blue Train",
      performer: "John Coltrane",
      remarks: ["DATE 1957"],
      files: [
        { path: "disc-one.flac", type: "WAVE" },
        { path: "disc-two.flac", type: "WAVE" }
      ],
      tracks: [
        {
          number: 1,
          fileIndex: 0,
          pregap: "00:00:32",
          postgap: "00:00:10",
          indexes: [
            { number: 0, time: "00:00:00" },
            { number: 1, time: "00:00:32" }
          ]
        },
        { number: 2, fileIndex: 1, indexes: [{ number: 1, time: "00:00:00" }] }
      ],
      unknownLines: ["; retained comment", "X-CUSTOM retained-value"]
    });
    expect(serializeCue(state.parsed, "utf8").toString("utf8")).toBe(rawText);
  });

  it("returns an item-addressable parse error instead of discarding the CUE", () => {
    const state = parseCue("INDEX 01 00:00:00", "D:/Music/broken.cue");

    expect(state.path).toBe("D:/Music/broken.cue");
    expect(state.rawText).toBe("INDEX 01 00:00:00");
    expect(state.parseError).toMatch(/No track found/i);
  });

  it("keeps unknown lines when structured fields are edited and validates INDEX 01", () => {
    const state = parseCue([
      'TITLE "Before"',
      'FILE "disc.flac" WAVE',
      "  TRACK 01 AUDIO",
      "    FLAGS DCP",
      "    INDEX 01 00:00:00",
      "; tail comment"
    ].join("\n"), "D:/Music/album.cue");
    state.parsed.title = "After";

    const serialized = serializeCue(state.parsed, "utf8").toString("utf8");

    expect(serialized).toContain('TITLE "After"');
    expect(serialized).toContain("    FLAGS DCP");
    expect(serialized).toContain("; tail comment");
    expect(() => serializeCue({
      ...state.parsed,
      tracks: [{ ...state.parsed.tracks[0], indexes: [] }]
    }, "utf8")).toThrow(/requires INDEX 01/i);
  });

  it("reads bytes before parsing and reports resolved missing FILE references", async () => {
    const directory = await createTempDir();
    const cuePath = path.join(directory, "album.cue");
    const rawText = 'FILE "missing.flac" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00';
    await writeFile(cuePath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(rawText)]));

    const state = await readCue(cuePath);

    expect(state.encoding).toBe("utf8-bom");
    expect(state.rawText).toBe(rawText);
    expect(state.referencedFiles).toEqual([path.join(directory, "missing.flac")]);
    expect(state.missingReferencedFiles).toEqual([path.join(directory, "missing.flac")]);
  });

  it("serializes UTF-8 BOM and creates a backup before atomically replacing an existing CUE", async () => {
    const directory = await createTempDir();
    const cuePath = path.join(directory, "album.cue");
    const original = 'TITLE "Before"\nFILE "disc.flac" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00';
    const replacement: CueDocument = {
      title: "After",
      remarks: [],
      files: [{ path: "disc.flac", type: "WAVE" }],
      tracks: [{ number: 1, fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }],
      unknownLines: []
    };
    await writeFile(cuePath, original);

    const result = await createCueService().saveCue({
      path: cuePath,
      document: replacement,
      rawText: "",
      encoding: "utf8-bom"
    });

    expect(result).toEqual({ ok: true, path: cuePath, backupPath: `${cuePath}.bak` });
    expect(await readFile(`${cuePath}.bak`, "utf8")).toBe(original);
    expect(await readFile(cuePath)).toEqual(serializeCue(replacement, "utf8-bom"));
  });

  it("saves a new CUE without creating a backup", async () => {
    const directory = await createTempDir();
    const cuePath = path.join(directory, "new.cue");
    const document: CueDocument = {
      remarks: [],
      files: [{ path: "disc.flac", type: "WAVE" }],
      tracks: [{ number: 1, fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }],
      unknownLines: []
    };

    const result = await createCueService().saveCue({ path: cuePath, document, rawText: "", encoding: "utf8" });

    expect(result).toEqual({ ok: true, path: cuePath });
    await expect(readFile(`${cuePath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves the original intact when atomic replacement fails", async () => {
    const directory = await createTempDir();
    const cuePath = path.join(directory, "album.cue");
    const original = 'TITLE "Before"\nFILE "disc.flac" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00';
    const replacement: CueDocument = {
      title: "After",
      remarks: [],
      files: [{ path: "disc.flac", type: "WAVE" }],
      tracks: [{ number: 1, fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }],
      unknownLines: []
    };
    await writeFile(cuePath, original);
    const service = createCueService({
      rename: async () => { throw new Error("replace denied"); }
    });

    const result = await service.saveCue({ path: cuePath, document: replacement, rawText: "", encoding: "utf8" });

    expect(result).toEqual({ ok: false, error: "replace denied" });
    expect(await readFile(cuePath, "utf8")).toBe(original);
  });
});
