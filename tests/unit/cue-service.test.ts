import { mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
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

  it("rejects a trailing AUDIO track without INDEX 01 when parsing and saving raw text", async () => {
    const rawText = [
      'FILE "disc.flac" WAVE',
      "  TRACK 01 AUDIO",
      "    INDEX 01 00:00:00",
      "  TRACK 02 AUDIO",
      '    TITLE "Dangling"'
    ].join("\n");
    const state = parseCue(rawText, "D:/Music/dangling.cue");
    const directory = await createTempDir();
    const cuePath = path.join(directory, "dangling.cue");
    const validDocument: CueDocument = {
      remarks: [],
      files: [{ path: "disc.flac", type: "WAVE" }],
      tracks: [{ number: 1, fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }],
      unknownLines: []
    };

    const saved = await createCueService().saveCue({
      path: cuePath,
      document: validDocument,
      rawText,
      encoding: "utf8"
    });

    expect(state.parseError).toMatch(/TRACK 02.*INDEX 01/i);
    expect(saved).toEqual({ ok: false, error: expect.stringMatching(/TRACK 02.*INDEX 01/i) });
  });

  it("rejects a trailing data track without INDEX 01 when parsing and saving raw text", async () => {
    const rawText = [
      'FILE "disc.bin" BINARY',
      "  TRACK 01 MODE1/2352",
      "    INDEX 01 00:00:00",
      "  TRACK 02 MODE1/2352"
    ].join("\n");
    const state = parseCue(rawText, "D:/Disc/disc.cue");
    const directory = await createTempDir();
    const cuePath = path.join(directory, "disc.cue");
    const submitted: CueDocument = {
      remarks: [],
      files: [{ path: "disc.bin", type: "BINARY" }],
      tracks: [{ number: 1, type: "MODE1/2352", fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }],
      unknownLines: []
    };

    const saved = await createCueService().saveCue({ path: cuePath, document: submitted, rawText, encoding: "utf8" });

    expect(state.parseError).toMatch(/TRACK 02.*INDEX 01/i);
    expect(saved).toEqual({ ok: false, error: expect.stringMatching(/TRACK 02.*INDEX 01/i) });
  });

  it("rejects forged source bookkeeping instead of serializing unparsed renderer text", async () => {
    const directory = await createTempDir();
    const cuePath = path.join(directory, "forged.cue");
    const document: CueDocument = {
      title: "Safe",
      remarks: [],
      files: [{ path: "disc.flac", type: "WAVE" }],
      tracks: [{ number: 1, fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }],
      unknownLines: [],
      sourceText: "THIS IS NOT A CUE"
    };
    document.sourceFingerprint = JSON.stringify({
      title: document.title,
      performer: document.performer,
      songwriter: document.songwriter,
      remarks: document.remarks,
      files: document.files,
      tracks: document.tracks,
      unknownLines: document.unknownLines
    });

    expect(() => serializeCue(document, "utf8")).toThrow();
    await expect(createCueService().saveCue({
      path: cuePath,
      document,
      rawText: document.sourceText,
      encoding: "utf8"
    })).resolves.toEqual({ ok: false, error: expect.any(String) });
    await expect(readFile(cuePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses canonical structured output when valid renderer raw text has a different projection", async () => {
    const directory = await createTempDir();
    const cuePath = path.join(directory, "mismatch.cue");
    const document: CueDocument = {
      title: "Trusted structured title",
      remarks: [],
      files: [{ path: "disc.flac", type: "WAVE" }],
      tracks: [{ number: 1, fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }],
      unknownLines: []
    };
    const differentRawText = [
      'TITLE "Different raw title"',
      'FILE "disc.flac" WAVE',
      "  TRACK 01 AUDIO",
      "    INDEX 01 00:00:00"
    ].join("\n");

    const result = await createCueService().saveCue({
      path: cuePath,
      document,
      rawText: differentRawText,
      encoding: "utf8"
    });

    expect(result).toEqual({ ok: true, path: cuePath });
    expect(await readFile(cuePath, "utf8")).toContain('TITLE "Trusted structured title"');
    expect(await readFile(cuePath, "utf8")).not.toContain("Different raw title");
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

  it("keeps preserved album, file, and track directives in their original scopes after an edit", () => {
    const state = parseCue([
      "CATALOG 1234567890123",
      'CDTEXTFILE "album.cdtext"',
      "; album comment",
      "",
      'TITLE "Album"',
      'FILE "disc.flac" WAVE',
      "  X-FILE file-note",
      "  TRACK 01 AUDIO",
      '    TITLE "Before"',
      "    FLAGS DCP PRE",
      "    ISRC USABC1234567",
      "    ; track one comment",
      "    INDEX 01 00:00:00",
      "  TRACK 02 AUDIO",
      '    TITLE "Two"',
      "    INDEX 01 03:00:00"
    ].join("\n"), "D:/Music/scoped.cue");
    state.parsed.tracks[0].title = "After";

    const lines = serializeCue(state.parsed, "utf8").toString("utf8").split("\n");
    const file = lines.indexOf('FILE "disc.flac" WAVE');
    const track1 = lines.indexOf("  TRACK 01 AUDIO");
    const flags = lines.indexOf("    FLAGS DCP PRE");
    const isrc = lines.indexOf("    ISRC USABC1234567");
    const track2 = lines.indexOf("  TRACK 02 AUDIO");

    expect(lines.indexOf("CATALOG 1234567890123")).toBeLessThan(file);
    expect(lines.indexOf('CDTEXTFILE "album.cdtext"')).toBeLessThan(file);
    expect(lines.indexOf("; album comment")).toBeLessThan(file);
    expect(lines.indexOf("  X-FILE file-note")).toBeGreaterThan(file);
    expect(lines.indexOf("  X-FILE file-note")).toBeLessThan(track1);
    expect(lines).toContain('    TITLE "After"');
    expect(flags).toBeGreaterThan(track1);
    expect(isrc).toBeGreaterThan(flags);
    expect(isrc).toBeLessThan(track2);
    expect(lines.indexOf("    ; track one comment")).toBeLessThan(track2);
  });

  it("interleaves preserved lines at their original positions within every scope", () => {
    const rawText = [
      "; before album title",
      'TITLE "Album"',
      "X-ALBUM-AFTER after-title",
      'FILE "disc-one.flac" WAVE',
      "  ; file-one comment",
      "  TRACK 01 AUDIO",
      '    TITLE "Before"',
      "    X-BEFORE-PREGAP retained",
      "    PREGAP 00:00:10",
      "    INDEX 00 00:00:00",
      "    INDEX 01 00:00:10",
      "",
      "    X-AFTER-INDEX retained",
      "    POSTGAP 00:00:05",
      "    ; after postgap",
      "  TRACK 02 AUDIO",
      '    TITLE "Two"',
      "    INDEX 01 03:00:00",
      "    ; track-two tail",
      'FILE "disc-two.flac" WAVE',
      "  ; file-two comment",
      "  TRACK 03 AUDIO",
      '    TITLE "Three"',
      "    INDEX 01 00:00:00"
    ].join("\n");
    const state = parseCue(rawText, "D:/Music/ordered.cue");
    state.parsed.tracks[0].title = "After";
    const expected = rawText.replace('TITLE "Before"', 'TITLE "After"');

    expect(serializeCue(state.parsed, "utf8").toString("utf8")).toBe(expected);
  });

  it.each(["1" as unknown as number, Number.NaN, -1, 0.5])(
    "rejects renderer-shaped invalid preserved-line position %s",
    (position) => {
      const document: CueDocument = {
        title: "Album",
        remarks: [],
        files: [{ path: "disc.flac" }],
        tracks: [{ number: 1, fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }],
        unknownLines: ["; comment"],
        preservedLines: [{ text: "; comment", scope: "album", order: 0, position }]
      };

      expect(() => serializeCue(document, "utf8")).toThrow(/non-negative position anchor/i);
    }
  );

  it.each([
    { text: "; comment", scope: "unexpected", order: 0, position: 0 },
    { text: "; comment", scope: "file", fileIndex: "0", order: 0, position: 0 },
    { text: "; comment", scope: "track", fileIndex: 0, trackIndex: "0", order: 0, position: 0 }
  ])("rejects an untrusted preserved-line anchor %#", (preservedLine) => {
    const document: CueDocument = {
      title: "Album",
      remarks: [],
      files: [{ path: "disc.flac" }],
      tracks: [{ number: 1, fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }],
      unknownLines: ["; comment"],
      preservedLines: [preservedLine as unknown as NonNullable<CueDocument["preservedLines"]>[number]]
    };

    expect(() => serializeCue(document, "utf8")).toThrow(/invalid preserved-line anchor/i);
  });

  it("rejects decreasing FILE indices that would reorder sequential tracks", () => {
    const document: CueDocument = {
      remarks: [],
      files: [{ path: "one.flac" }, { path: "two.flac" }],
      tracks: [
        { number: 1, fileIndex: 1, indexes: [{ number: 1, time: "00:00:00" }] },
        { number: 2, fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }
      ],
      unknownLines: []
    };

    expect(() => serializeCue(document, "utf8")).toThrow(/FILE indices.*nondecreasing/i);
  });

  it.each([
    "0" as unknown as number,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    0.5,
    -1
  ])("rejects renderer-shaped invalid FILE index %s", (fileIndex) => {
    const document: CueDocument = {
      remarks: [],
      files: [{ path: "disc.flac" }],
      tracks: [{ number: 1, fileIndex, indexes: [{ number: 1, time: "00:00:00" }] }],
      unknownLines: []
    };

    expect(() => serializeCue(document, "utf8")).toThrow(/FILE index must be an integer in range/i);
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

  it("leaves the original intact and no backup when replacement fails without an existing backup", async () => {
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
    await expect(readFile(`${cuePath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(directory)).toEqual(["album.cue"]);
  });

  it("leaves the original and a pre-existing backup intact when destination replacement fails", async () => {
    const directory = await createTempDir();
    const cuePath = path.join(directory, "album.cue");
    const backupPath = `${cuePath}.bak`;
    const original = 'TITLE "Current"\nFILE "disc.flac" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00';
    const priorBackup = 'TITLE "Older backup"';
    const replacement: CueDocument = {
      title: "Replacement",
      remarks: [],
      files: [{ path: "disc.flac", type: "WAVE" }],
      tracks: [{ number: 1, fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }],
      unknownLines: []
    };
    await writeFile(cuePath, original);
    await writeFile(backupPath, priorBackup);
    const service = createCueService({ rename: async () => { throw new Error("replace denied"); } });

    const result = await service.saveCue({ path: cuePath, document: replacement, rawText: "", encoding: "utf8" });

    expect(result).toEqual({ ok: false, error: "replace denied" });
    expect(await readFile(cuePath, "utf8")).toBe(original);
    expect(await readFile(backupPath, "utf8")).toBe(priorBackup);
    expect((await readdir(directory)).sort()).toEqual(["album.cue", "album.cue.bak"]);
  });

  it("replaces a pre-existing backup with the immediately previous CUE on success", async () => {
    const directory = await createTempDir();
    const cuePath = path.join(directory, "album.cue");
    const original = 'TITLE "Current"\nFILE "disc.flac" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00';
    const replacement: CueDocument = {
      title: "Replacement",
      remarks: [],
      files: [{ path: "disc.flac", type: "WAVE" }],
      tracks: [{ number: 1, fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }],
      unknownLines: []
    };
    await writeFile(cuePath, original);
    await writeFile(`${cuePath}.bak`, 'TITLE "Older backup"');

    const result = await createCueService().saveCue({
      path: cuePath,
      document: replacement,
      rawText: "",
      encoding: "utf8"
    });

    expect(result).toEqual({ ok: true, path: cuePath, backupPath: `${cuePath}.bak` });
    expect(await readFile(`${cuePath}.bak`, "utf8")).toBe(original);
  });

  it("restores the original and preserves the prior backup when backup publication fails", async () => {
    const directory = await createTempDir();
    const cuePath = path.join(directory, "album.cue");
    const backupPath = `${cuePath}.bak`;
    const original = 'TITLE "Current"\nFILE "disc.flac" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00';
    const priorBackup = 'TITLE "Prior backup"';
    const replacement: CueDocument = {
      title: "Replacement",
      remarks: [],
      files: [{ path: "disc.flac" }],
      tracks: [{ number: 1, fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }],
      unknownLines: []
    };
    await writeFile(cuePath, original);
    await writeFile(backupPath, priorBackup);
    const service = createCueService({
      rename: async (source, destination) => {
        if (destination === backupPath) {
          throw new Error("backup publish denied");
        }
        await rename(source, destination);
      }
    });

    const result = await service.saveCue({ path: cuePath, document: replacement, rawText: "", encoding: "utf8" });

    expect(result).toEqual({ ok: false, error: "backup publish denied" });
    expect(await readFile(cuePath, "utf8")).toBe(original);
    expect(await readFile(backupPath, "utf8")).toBe(priorBackup);
    expect((await readdir(directory)).sort()).toEqual(["album.cue", "album.cue.bak"]);
  });
});
