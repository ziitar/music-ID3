import { link, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCueService,
  parseCue,
  readCue,
  serializeCue
} from "../../electron/services/cue-service";
import type { CueDocument, SaveCueInput, SaveCueResult } from "../../shared/types";

const temporaryDirectories: string[] = [];

async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "music-id3-cue-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function savePreparedCue(
  service: ReturnType<typeof createCueService>,
  input: SaveCueInput,
  scope = "local-main"
): Promise<SaveCueResult> {
  const { confirmationToken: _rendererToken, ...draft } = input;
  try {
    const confirmationToken = await service.prepareCueSave(draft, scope);
    return service.saveCue({ ...draft, confirmationToken }, scope);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
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
      encoding: "utf8",
      confirmationToken: "dangling-audio"
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

    const saved = await createCueService().saveCue({ path: cuePath, document: submitted, rawText, encoding: "utf8", confirmationToken: "dangling-data" });

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
      encoding: "utf8",
      confirmationToken: "forged-source"
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

    const result = await savePreparedCue(createCueService(), {
      path: cuePath,
      document,
      rawText: differentRawText,
      encoding: "utf8",
      confirmationToken: "different-projection"
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

  it("keeps a title tail comment after TITLE when PERFORMER is added", () => {
    const rawText = [
      'TITLE "Album"',
      "; title tail",
      'FILE "disc.flac" WAVE',
      "  TRACK 01 AUDIO",
      "    INDEX 01 00:00:00"
    ].join("\n");
    const state = parseCue(rawText, "D:/Music/album.cue");
    state.parsed.performer = "Artist";

    expect(serializeCue(state.parsed, "utf8").toString("utf8")).toBe([
      'PERFORMER "Artist"',
      'TITLE "Album"',
      "; title tail",
      'FILE "disc.flac" WAVE',
      "  TRACK 01 AUDIO",
      "    INDEX 01 00:00:00"
    ].join("\n"));
  });

  it("keeps leading preserved lines before newly inserted modeled directives in source scopes", () => {
    const rawText = [
      "; album header",
      "",
      'FILE "disc.flac" WAVE',
      "  ; file header",
      "  TRACK 01 AUDIO",
      "    ; track header",
      "    INDEX 01 00:00:00"
    ].join("\n");
    const state = parseCue(rawText, "D:/Music/headers.cue");
    state.parsed.title = "Album";
    state.parsed.tracks[0].title = "Track";

    expect(serializeCue(state.parsed, "utf8").toString("utf8")).toBe([
      "; album header",
      "",
      'TITLE "Album"',
      'FILE "disc.flac" WAVE',
      "  ; file header",
      "  TRACK 01 AUDIO",
      "    ; track header",
      '    TITLE "Track"',
      "    INDEX 01 00:00:00"
    ].join("\n"));
  });

  it("keeps an index tail comment after INDEX 01 when INDEX 00 is added", () => {
    const rawText = [
      'FILE "disc.flac" WAVE',
      "  TRACK 01 AUDIO",
      "    INDEX 01 00:00:10",
      "    ; index tail"
    ].join("\n");
    const state = parseCue(rawText, "D:/Music/album.cue");
    state.parsed.tracks[0].indexes.unshift({ number: 0, time: "00:00:00" });

    expect(serializeCue(state.parsed, "utf8").toString("utf8")).toBe([
      'FILE "disc.flac" WAVE',
      "  TRACK 01 AUDIO",
      "    INDEX 00 00:00:00",
      "    INDEX 01 00:00:10",
      "    ; index tail"
    ].join("\n"));
  });

  it.each([
    [
      ['TITLE "Before"', "; between", 'PERFORMER "Before Artist"'],
      ['TITLE "After"', "; between", 'PERFORMER "After Artist"']
    ],
    [
      ['PERFORMER "Before Artist"', "; between", 'TITLE "Before"'],
      ['PERFORMER "After Artist"', "; between", 'TITLE "After"']
    ]
  ])("retains a comment between the same noncanonical neighboring directives", (albumLines, expectedAlbumLines) => {
    const suffix = ['FILE "disc.flac" WAVE', "  TRACK 01 AUDIO", "    INDEX 01 00:00:00"];
    const state = parseCue([...albumLines, ...suffix].join("\n"), "D:/Music/noncanonical.cue");
    state.parsed.title = "After";
    state.parsed.performer = "After Artist";

    expect(serializeCue(state.parsed, "utf8").toString("utf8")).toBe([...expectedAlbumLines, ...suffix].join("\n"));
  });

  it("retains same-position comments and blank lines in source order", () => {
    const rawText = [
      'TITLE "Before"',
      "; first",
      "",
      "; second",
      'FILE "disc.flac" WAVE',
      "  TRACK 01 AUDIO",
      "    INDEX 01 00:00:00"
    ].join("\n");
    const state = parseCue(rawText, "D:/Music/comments.cue");
    state.parsed.title = "After";

    expect(serializeCue(state.parsed, "utf8").toString("utf8")).toBe(rawText.replace("Before", "After"));
  });

  it("uses the trusted source layout to validate anchors after a modeled field is removed", () => {
    const rawText = [
      'PERFORMER "Artist"',
      'TITLE "Album"',
      "; title tail",
      'FILE "disc.flac" WAVE',
      "  TRACK 01 AUDIO",
      "    INDEX 01 00:00:00"
    ].join("\n");
    const state = parseCue(rawText, "D:/Music/comments.cue");
    delete state.parsed.performer;

    expect(serializeCue(state.parsed, "utf8").toString("utf8")).toBe([
      'TITLE "Album"',
      "; title tail",
      'FILE "disc.flac" WAVE',
      "  TRACK 01 AUDIO",
      "    INDEX 01 00:00:00"
    ].join("\n"));
  });

  it("rejects duplicate desired INDEX numbers in a source-backed track", () => {
    const state = parseCue([
      'FILE "disc.flac" WAVE',
      "  TRACK 01 AUDIO",
      "    INDEX 01 00:00:00"
    ].join("\n"), "D:/Music/duplicate-source.cue");
    state.parsed.tracks[0].indexes.push({ number: 1, time: "00:01:00" });

    expect(() => serializeCue(state.parsed, "utf8")).toThrow(/TRACK 1.*duplicate INDEX 01/i);
  });

  it("rejects duplicate INDEX numbers in a canonical document while allowing distinct 00, 01, and 02", () => {
    const document: CueDocument = {
      remarks: [],
      files: [{ path: "disc.flac" }],
      tracks: [{
        number: 1,
        fileIndex: 0,
        indexes: [
          { number: 0, time: "00:00:00" },
          { number: 1, time: "00:00:10" },
          { number: 2, time: "00:00:20" }
        ]
      }],
      unknownLines: []
    };

    expect(serializeCue(document, "utf8").toString("utf8")).toContain("    INDEX 02 00:00:20");
    document.tracks[0].indexes.push({ number: 2, time: "00:00:30" });
    expect(() => serializeCue(document, "utf8")).toThrow(/TRACK 1.*duplicate INDEX 02/i);
  });

  it.each(["1" as unknown as number, Number.NaN, -1, 0.5, 999])(
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

    const result = await savePreparedCue(createCueService(), {
      path: cuePath,
      document: replacement,
      rawText: "",
      encoding: "utf8-bom",
      confirmationToken: "replace-with-bom"
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

    const result = await savePreparedCue(createCueService(), { path: cuePath, document, rawText: "", encoding: "utf8", confirmationToken: "new-cue" });

    expect(result).toEqual({ ok: true, path: cuePath });
    await expect(readFile(`${cuePath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a new-file save successful when redundant hard-link cleanup fails", async () => {
    const directory = await createTempDir();
    const cuePath = path.join(directory, "new-cleanup-failure.cue");
    const document: CueDocument = {
      title: "Committed",
      remarks: [],
      files: [{ path: "disc.flac", type: "WAVE" }],
      tracks: [{ number: 1, fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }],
      unknownLines: []
    };
    const service = createCueService({
      unlink: async (target) => {
        if (target.toString().startsWith(`${cuePath}.`) && target.toString().endsWith(".tmp")) {
          throw new Error("temporary cleanup denied");
        }
        await unlink(target);
      }
    });

    const result = await savePreparedCue(service, {
      path: cuePath,
      document,
      rawText: "",
      encoding: "utf8",
      confirmationToken: "new-cleanup-failure"
    });

    expect(result).toEqual({ ok: true, path: cuePath });
    expect(await readFile(cuePath)).toEqual(serializeCue(document, "utf8"));
    expect((await readdir(directory)).some((name) => name.endsWith(".tmp"))).toBe(true);
  });

  it("keeps a replacement successful when redundant hard-link cleanup fails", async () => {
    const directory = await createTempDir();
    const cuePath = path.join(directory, "replace-cleanup-failure.cue");
    const original = 'TITLE "Original"\nFILE "disc.flac" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00';
    const document: CueDocument = {
      title: "Committed",
      remarks: [],
      files: [{ path: "disc.flac", type: "WAVE" }],
      tracks: [{ number: 1, fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }],
      unknownLines: []
    };
    await writeFile(cuePath, original);
    const service = createCueService({
      unlink: async (target) => {
        if (target.toString().startsWith(`${cuePath}.`) && target.toString().endsWith(".tmp")) {
          throw new Error("temporary cleanup denied");
        }
        await unlink(target);
      }
    });

    const result = await savePreparedCue(service, {
      path: cuePath,
      document,
      rawText: "",
      encoding: "utf8",
      confirmationToken: "replace-cleanup-failure"
    });

    expect(result).toEqual({ ok: true, path: cuePath, backupPath: `${cuePath}.bak` });
    expect(await readFile(cuePath)).toEqual(serializeCue(document, "utf8"));
    expect(await readFile(`${cuePath}.bak`, "utf8")).toBe(original);
    expect((await readdir(directory)).some((name) => name.endsWith(".tmp"))).toBe(true);
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

    const result = await savePreparedCue(service, { path: cuePath, document: replacement, rawText: "", encoding: "utf8", confirmationToken: "replacement-denied" });

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

    const result = await savePreparedCue(service, { path: cuePath, document: replacement, rawText: "", encoding: "utf8", confirmationToken: "replacement-with-backup-denied" });

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

    const result = await savePreparedCue(createCueService(), {
      path: cuePath,
      document: replacement,
      rawText: "",
      encoding: "utf8",
      confirmationToken: "replace-prior-backup"
    });

    expect(result).toEqual({ ok: true, path: cuePath, backupPath: `${cuePath}.bak` });
    expect(await readFile(`${cuePath}.bak`, "utf8")).toBe(original);
  });

  it("keeps the original backup when the same confirmation token is submitted twice", async () => {
    const directory = await createTempDir();
    const cuePath = path.join(directory, "duplicate.cue");
    const original = 'TITLE "Original"\nFILE "disc.flac" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00';
    const replacement: CueDocument = {
      title: "Replacement",
      remarks: [],
      files: [{ path: "disc.flac", type: "WAVE" }],
      tracks: [{ number: 1, fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }],
      unknownLines: []
    };
    await writeFile(cuePath, original);
    const service = createCueService();
    const draft = { path: cuePath, document: replacement, rawText: "", encoding: "utf8" as const };
    const confirmationToken = await service.prepareCueSave(draft, "renderer-1");
    const input = { ...draft, confirmationToken };

    const firstOperation = service.saveCue(input, "renderer-1");
    const duplicateOperation = service.saveCue(input, "renderer-1");
    const [first, duplicate] = await Promise.all([firstOperation, duplicateOperation]);

    expect(duplicateOperation).toBe(firstOperation);
    expect(first).toEqual({ ok: true, path: cuePath, backupPath: `${cuePath}.bak` });
    expect(duplicate).toEqual(first);
    expect(await readFile(`${cuePath}.bak`, "utf8")).toBe(original);
  });

  it("keeps an in-flight duplicate idempotent while completed-save cache entries are evicted", async () => {
    const directory = await createTempDir();
    const cuePath = path.join(directory, "slow.cue");
    const original = 'TITLE "Original"\nFILE "disc.flac" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00';
    const replacement: CueDocument = {
      title: "Replacement",
      remarks: [],
      files: [{ path: "disc.flac", type: "WAVE" }],
      tracks: [{ number: 1, fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }],
      unknownLines: []
    };
    await writeFile(cuePath, original);
    let releaseRename!: () => void;
    let markRenameStarted!: () => void;
    const renameReleased = new Promise<void>((resolve) => { releaseRename = resolve; });
    const renameStarted = new Promise<void>((resolve) => { markRenameStarted = resolve; });
    let heldRename = false;
    const holdPublish = async (source: Parameters<typeof rename>[0], destination: Parameters<typeof rename>[1], publish: typeof rename | typeof link) => {
      if (!heldRename && destination.toString() === cuePath) {
        heldRename = true;
        markRenameStarted();
        await renameReleased;
      }
      await publish(source, destination);
    };
    const service = createCueService({
      rename: (source, destination) => holdPublish(source, destination, rename),
      link: (source, destination) => holdPublish(source, destination, link)
    });
    const draft = { path: cuePath, document: replacement, rawText: "", encoding: "utf8" as const };
    const confirmationToken = await service.prepareCueSave(draft, "renderer-1");
    const input = { ...draft, confirmationToken };

    const firstOperation = service.saveCue(input, "renderer-1");
    await renameStarted;
    for (let index = 0; index < 512; index += 1) {
      const unrelatedDraft = { ...draft, path: path.join(directory, `completed-${index}.cue`) };
      const unrelatedToken = await service.prepareCueSave(unrelatedDraft, "renderer-1");
      await service.saveCue({ ...unrelatedDraft, confirmationToken: unrelatedToken }, "renderer-1");
    }
    const duplicateOperation = service.saveCue(input, "renderer-1");
    const sameOperation = duplicateOperation === firstOperation;
    releaseRename();
    const [first, duplicate] = await Promise.all([firstOperation, duplicateOperation]);

    expect(sameOperation).toBe(true);
    expect(first).toEqual({ ok: true, path: cuePath, backupPath: `${cuePath}.bak` });
    expect(duplicate).toEqual(first);
    expect(await readFile(`${cuePath}.bak`, "utf8")).toBe(original);
  });

  it("allows only one distinct save intent prepared from the same CUE revision", async () => {
    const directory = await createTempDir();
    const cuePath = path.join(directory, "concurrent.cue");
    const original = 'TITLE "Original"\nFILE "disc.flac" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00';
    const baseDocument: CueDocument = {
      remarks: [],
      files: [{ path: "disc.flac", type: "WAVE" }],
      tracks: [{ number: 1, fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }],
      unknownLines: []
    };
    await writeFile(cuePath, original);
    const service = createCueService();
    const firstDraft = { path: cuePath, document: { ...baseDocument, title: "First" }, rawText: "", encoding: "utf8" as const };
    const secondDraft = { path: cuePath, document: { ...baseDocument, title: "Second" }, rawText: "", encoding: "utf8" as const };
    const [firstToken, secondToken] = await Promise.all([
      service.prepareCueSave(firstDraft, "renderer-1"),
      service.prepareCueSave(secondDraft, "renderer-1")
    ]);

    expect(firstToken).not.toBe(secondToken);
    const firstOperation = service.saveCue({ ...firstDraft, confirmationToken: firstToken }, "renderer-1");
    const secondOperation = service.saveCue({ ...secondDraft, confirmationToken: secondToken }, "renderer-1");
    const [first, second] = await Promise.all([firstOperation, secondOperation]);

    expect(first).toEqual({ ok: true, path: cuePath, backupPath: `${cuePath}.bak` });
    expect(second).toEqual({ ok: false, error: expect.stringMatching(/changed since confirmation/i) });
    expect(await readFile(cuePath, "utf8")).toContain('TITLE "First"');
    expect(await readFile(`${cuePath}.bak`, "utf8")).toBe(original);
  });

  it("does not let bounded-cache eviction replay replacement or new-file confirmation tokens", async () => {
    const directory = await createTempDir();
    const existingPath = path.join(directory, "existing.cue");
    const newPath = path.join(directory, "new.cue");
    const original = 'TITLE "Original"\nFILE "disc.flac" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00';
    const replacement: CueDocument = {
      title: "Replacement",
      remarks: [],
      files: [{ path: "disc.flac", type: "WAVE" }],
      tracks: [{ number: 1, fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }],
      unknownLines: []
    };
    await writeFile(existingPath, original);
    const service = createCueService();
    const existingDraft = { path: existingPath, document: replacement, rawText: "", encoding: "utf8" as const };
    const newDraft = { ...existingDraft, path: newPath };
    const existingInput = { ...existingDraft, confirmationToken: await service.prepareCueSave(existingDraft, "renderer-1") };
    const newInput = { ...newDraft, confirmationToken: await service.prepareCueSave(newDraft, "renderer-1") };

    const firstExisting = await service.saveCue(existingInput, "renderer-1");
    const firstNew = await service.saveCue(newInput, "renderer-1");
    for (let index = 0; index < 512; index += 1) {
      const unrelatedDraft = { ...existingDraft, path: path.join(directory, `unrelated-${index}.cue`) };
      const confirmationToken = await service.prepareCueSave(unrelatedDraft, "renderer-1");
      await service.saveCue({ ...unrelatedDraft, confirmationToken }, "renderer-1");
    }

    const replayedExisting = await service.saveCue(existingInput, "renderer-1");
    const replayedNew = await service.saveCue(newInput, "renderer-1");

    expect(firstExisting).toEqual({ ok: true, path: existingPath, backupPath: `${existingPath}.bak` });
    expect(firstNew).toEqual({ ok: true, path: newPath });
    expect(replayedExisting).toEqual({ ok: false, error: expect.stringMatching(/invalid|expired|used/i) });
    expect(replayedNew).toEqual({ ok: false, error: expect.stringMatching(/invalid|expired|used/i) });
    expect(await readFile(`${existingPath}.bak`, "utf8")).toBe(original);
    await expect(readFile(`${newPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not retry failed replacement or creation tokens after completed-save cache eviction", async () => {
    const directory = await createTempDir();
    const existingPath = path.join(directory, "failed-existing.cue");
    const newPath = path.join(directory, "failed-new.cue");
    const original = 'TITLE "Original"\nFILE "disc.flac" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00';
    const replacement: CueDocument = {
      title: "Replacement",
      remarks: [],
      files: [{ path: "disc.flac", type: "WAVE" }],
      tracks: [{ number: 1, fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }],
      unknownLines: []
    };
    await writeFile(existingPath, original);
    const failedDestinations = new Set<string>();
    const service = createCueService({
      link: async (source, destination) => {
        const destinationPath = destination.toString();
        if ((destinationPath === existingPath || destinationPath === newPath) && !failedDestinations.has(destinationPath)) {
          failedDestinations.add(destinationPath);
          throw new Error("transient replace failure");
        }
        await link(source, destination);
      }
    });
    const existingDraft = { path: existingPath, document: replacement, rawText: "", encoding: "utf8" as const };
    const newDraft = { ...existingDraft, path: newPath };
    const existingInput = { ...existingDraft, confirmationToken: await service.prepareCueSave(existingDraft, "renderer-1") };
    const newInput = { ...newDraft, confirmationToken: await service.prepareCueSave(newDraft, "renderer-1") };

    const firstExisting = await service.saveCue(existingInput, "renderer-1");
    const firstNew = await service.saveCue(newInput, "renderer-1");
    for (let index = 0; index < 512; index += 1) {
      const unrelatedDraft = { ...existingDraft, path: path.join(directory, `after-failure-${index}.cue`) };
      const confirmationToken = await service.prepareCueSave(unrelatedDraft, "renderer-1");
      await service.saveCue({ ...unrelatedDraft, confirmationToken }, "renderer-1");
    }
    const replayedExisting = await service.saveCue(existingInput, "renderer-1");
    const replayedNew = await service.saveCue(newInput, "renderer-1");

    expect(firstExisting).toEqual({ ok: false, error: "transient replace failure" });
    expect(firstNew).toEqual({ ok: false, error: "transient replace failure" });
    expect(replayedExisting).toEqual({ ok: false, error: expect.stringMatching(/invalid|expired|used/i) });
    expect(replayedNew).toEqual({ ok: false, error: expect.stringMatching(/invalid|expired|used/i) });
    expect(await readFile(existingPath, "utf8")).toBe(original);
    await expect(readFile(`${existingPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(newPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(`${newPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("bounds unused confirmations by expiring the oldest without invalidating the newest", async () => {
    const directory = await createTempDir();
    const document: CueDocument = {
      title: "Prepared",
      remarks: [],
      files: [{ path: "disc.flac", type: "WAVE" }],
      tracks: [{ number: 1, fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }],
      unknownLines: []
    };
    const service = createCueService();
    const oldestDraft = { path: path.join(directory, "oldest.cue"), document, rawText: "", encoding: "utf8" as const };
    const oldestToken = await service.prepareCueSave(oldestDraft, "renderer-1");
    let newestDraft = oldestDraft;
    let newestToken = oldestToken;
    for (let index = 0; index < 512; index += 1) {
      newestDraft = { ...oldestDraft, path: path.join(directory, `pending-${index}.cue`) };
      newestToken = await service.prepareCueSave(newestDraft, "renderer-1");
    }

    await expect(service.saveCue({ ...oldestDraft, confirmationToken: oldestToken }, "renderer-1")).resolves.toEqual({
      ok: false,
      error: expect.stringMatching(/invalid|expired|used/i)
    });
    await expect(readFile(oldestDraft.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(service.saveCue({ ...newestDraft, confirmationToken: newestToken }, "renderer-1")).resolves.toEqual({
      ok: true,
      path: newestDraft.path
    });
  });

  it("binds a prepared confirmation token to its renderer, path, and intended CUE bytes", async () => {
    const directory = await createTempDir();
    const firstPath = path.join(directory, "first.cue");
    const secondPath = path.join(directory, "second.cue");
    const document: CueDocument = {
      title: "Prepared",
      remarks: [],
      files: [{ path: "disc.flac", type: "WAVE" }],
      tracks: [{ number: 1, fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }],
      unknownLines: []
    };
    const service = createCueService();
    const draft = { path: firstPath, document, rawText: "", encoding: "utf8" as const };
    const confirmationToken = await service.prepareCueSave(draft, "renderer-1");

    await expect(service.saveCue({ ...draft, path: secondPath, confirmationToken }, "renderer-1")).resolves.toEqual({ ok: false, error: expect.stringMatching(/invalid.*confirmation/i) });
    await expect(service.saveCue({ ...draft, confirmationToken }, "renderer-2")).resolves.toEqual({ ok: false, error: expect.stringMatching(/invalid.*confirmation/i) });
    await expect(service.saveCue({ ...draft, document: { ...document, title: "Altered" }, confirmationToken }, "renderer-1")).resolves.toEqual({ ok: false, error: expect.stringMatching(/invalid.*confirmation/i) });
    await expect(service.saveCue({ ...draft, confirmationToken }, "renderer-1")).resolves.toEqual({ ok: true, path: firstPath });
    await expect(readFile(secondPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a prepared save when the existing CUE revision changes before confirmation", async () => {
    const directory = await createTempDir();
    const cuePath = path.join(directory, "changed.cue");
    const original = 'TITLE "Original"\nFILE "disc.flac" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00';
    const external = 'TITLE "External"\nFILE "disc.flac" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00';
    const document: CueDocument = {
      title: "Prepared",
      remarks: [],
      files: [{ path: "disc.flac", type: "WAVE" }],
      tracks: [{ number: 1, fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }],
      unknownLines: []
    };
    await writeFile(cuePath, original);
    const service = createCueService();
    const draft = { path: cuePath, document, rawText: "", encoding: "utf8" as const };
    const confirmationToken = await service.prepareCueSave(draft, "renderer-1");
    await writeFile(cuePath, external);

    await expect(service.saveCue({ ...draft, confirmationToken }, "renderer-1")).resolves.toEqual({ ok: false, error: expect.stringMatching(/changed since confirmation/i) });
    expect(await readFile(cuePath, "utf8")).toBe(external);
    await expect(readFile(`${cuePath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not overwrite a new CUE created at the final publication boundary", async () => {
    const directory = await createTempDir();
    const cuePath = path.join(directory, "created-concurrently.cue");
    const concurrentContents = 'TITLE "Created elsewhere"';
    const document: CueDocument = {
      title: "Prepared",
      remarks: [],
      files: [{ path: "disc.flac", type: "WAVE" }],
      tracks: [{ number: 1, fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }],
      unknownLines: []
    };
    let raced = false;
    const race = async (source: Parameters<typeof rename>[0], destination: Parameters<typeof rename>[1], publish: typeof rename | typeof link) => {
      if (!raced && destination.toString() === cuePath) {
        raced = true;
        await writeFile(cuePath, concurrentContents);
      }
      await publish(source, destination);
    };
    const racingRename: typeof rename = (source, destination) => race(source, destination, rename);
    const racingLink: typeof link = (source, destination) => race(source, destination, link);
    const service = createCueService({ rename: racingRename, link: racingLink });
    const draft = { path: cuePath, document, rawText: "", encoding: "utf8" as const };
    const confirmationToken = await service.prepareCueSave(draft, "renderer-1");

    const result = await service.saveCue({ ...draft, confirmationToken }, "renderer-1");

    expect(result).toEqual({ ok: false, error: expect.stringMatching(/exist|changed|publish/i) });
    expect(await readFile(cuePath, "utf8")).toBe(concurrentContents);
    expect(await readdir(directory)).toEqual(["created-concurrently.cue"]);
  });

  it("preserves a CUE changed at the final publication boundary and retains the confirmed original", async () => {
    const directory = await createTempDir();
    const cuePath = path.join(directory, "changed-concurrently.cue");
    const backupPath = `${cuePath}.bak`;
    const original = 'TITLE "Original"\nFILE "disc.flac" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00';
    const priorBackup = 'TITLE "Prior backup"';
    const concurrentContents = 'TITLE "Changed elsewhere"';
    const document: CueDocument = {
      title: "Prepared",
      remarks: [],
      files: [{ path: "disc.flac", type: "WAVE" }],
      tracks: [{ number: 1, fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }],
      unknownLines: []
    };
    await writeFile(cuePath, original);
    await writeFile(backupPath, priorBackup);
    let raced = false;
    const race = async (source: Parameters<typeof rename>[0], destination: Parameters<typeof rename>[1], publish: typeof rename | typeof link) => {
      if (!raced && destination.toString() === cuePath) {
        raced = true;
        await writeFile(cuePath, concurrentContents);
      }
      await publish(source, destination);
    };
    const racingRename: typeof rename = (source, destination) => race(source, destination, rename);
    const racingLink: typeof link = (source, destination) => race(source, destination, link);
    const service = createCueService({ rename: racingRename, link: racingLink });
    const draft = { path: cuePath, document, rawText: "", encoding: "utf8" as const };
    const confirmationToken = await service.prepareCueSave(draft, "renderer-1");

    const result = await service.saveCue({ ...draft, confirmationToken }, "renderer-1");
    const otherContents = await Promise.all(
      (await readdir(directory))
        .filter((name) => ![path.basename(cuePath), path.basename(backupPath)].includes(name))
        .map((name) => readFile(path.join(directory, name), "utf8"))
    );

    expect(result).toEqual({ ok: false, error: expect.stringMatching(/recovery copy retained/i) });
    expect(await readFile(cuePath, "utf8")).toBe(concurrentContents);
    expect(await readFile(backupPath, "utf8")).toBe(priorBackup);
    expect(otherContents).toContain(original);
  });

  it("retains and surfaces the only original recovery copy when backup publication and rollback both fail", async () => {
    const directory = await createTempDir();
    const cuePath = path.join(directory, "recovery.cue");
    const backupPath = `${cuePath}.bak`;
    const original = 'TITLE "Original"\nFILE "disc.flac" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00';
    const priorBackup = 'TITLE "Prior backup"';
    const replacement: CueDocument = {
      title: "Replacement",
      remarks: [],
      files: [{ path: "disc.flac", type: "WAVE" }],
      tracks: [{ number: 1, fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }],
      unknownLines: []
    };
    await writeFile(cuePath, original);
    await writeFile(backupPath, priorBackup);
    const service = createCueService({
      rename: async (source, destination) => {
        if (destination === backupPath) throw new Error("backup publish denied");
        await rename(source, destination);
      },
      link: async (source, destination) => {
        if (destination === cuePath && source.includes(".bak.")) throw new Error("rollback denied");
        await link(source, destination);
      }
    });

    const result = await savePreparedCue(service, { path: cuePath, document: replacement, rawText: "", encoding: "utf8", confirmationToken: "recovery-confirmation" });
    const files = await readdir(directory);
    const contents = await Promise.all(files.map((name) => readFile(path.join(directory, name), "utf8")));

    expect(result).toEqual({ ok: false, error: expect.stringMatching(/recovery copy.*\.tmp/i) });
    expect(contents).toContain(original);
    expect(await readFile(backupPath, "utf8")).toBe(priorBackup);
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

    const result = await savePreparedCue(service, { path: cuePath, document: replacement, rawText: "", encoding: "utf8", confirmationToken: "backup-publication-denied" });

    expect(result).toEqual({ ok: false, error: "backup publish denied" });
    expect(await readFile(cuePath, "utf8")).toBe(original);
    expect(await readFile(backupPath, "utf8")).toBe(priorBackup);
    expect((await readdir(directory)).sort()).toEqual(["album.cue", "album.cue.bak"]);
  });

  it("preserves a destination changed during backup-publication failure and retains the confirmed original", async () => {
    const directory = await createTempDir();
    const cuePath = path.join(directory, "concurrent-backup-failure.cue");
    const backupPath = `${cuePath}.bak`;
    const original = 'TITLE "Original"\nFILE "disc.flac" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00';
    const priorBackup = 'TITLE "Prior backup"';
    const concurrent = 'TITLE "Concurrent"';
    const replacement: CueDocument = {
      title: "Replacement",
      remarks: [],
      files: [{ path: "disc.flac", type: "WAVE" }],
      tracks: [{ number: 1, fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }],
      unknownLines: []
    };
    await writeFile(cuePath, original);
    await writeFile(backupPath, priorBackup);
    const service = createCueService({
      rename: async (source, destination) => {
        if (destination.toString() === backupPath) {
          await writeFile(cuePath, concurrent);
          throw new Error("backup publish denied");
        }
        await rename(source, destination);
      }
    });

    const result = await savePreparedCue(service, {
      path: cuePath,
      document: replacement,
      rawText: "",
      encoding: "utf8",
      confirmationToken: "concurrent-backup-failure"
    });
    const retainedContents = await Promise.all(
      (await readdir(directory))
        .filter((name) => ![path.basename(cuePath), path.basename(backupPath)].includes(name))
        .map((name) => readFile(path.join(directory, name), "utf8"))
    );

    expect(result).toEqual({ ok: false, error: expect.stringMatching(/destination changed.*recovery copy retained/i) });
    expect(await readFile(cuePath, "utf8")).toBe(concurrent);
    expect(await readFile(backupPath, "utf8")).toBe(priorBackup);
    expect(retainedContents).toContain(original);
  });

  it("rejects embedded double quotes in structured values instead of changing their text", () => {
    const document: CueDocument = {
      title: 'A "quoted" album',
      remarks: [],
      files: [{ path: "disc.flac", type: "WAVE" }],
      tracks: [{ number: 1, fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }],
      unknownLines: []
    };

    expect(() => serializeCue(document, "utf8")).toThrow(/double quote.*raw mode/i);
  });
});
