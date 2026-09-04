import { randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  readFile,
  rename,
  unlink,
  writeFile
} from "node:fs/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseCueFile } from "cue-parser";
import type { ICueSheet, ITime, ITrack } from "cue-parser/lib/types";
import type {
  CueDocument,
  CueDocumentState,
  CueEncoding,
  CuePreservedLine,
  CueTrack,
  SaveCueInput,
  SaveCueResult
} from "../../shared/types";
import { decodeCueBytes, encodeCueText } from "./cue-encoding";

type CueServiceDependencies = {
  access: typeof access;
  copyFile: typeof copyFile;
  readFile: typeof readFile;
  rename: typeof rename;
  unlink: typeof unlink;
  writeFile: typeof writeFile;
};

const parserCommands = new Set([
  "CATALOG",
  "CDTEXTFILE",
  "FILE",
  "FLAGS",
  "INDEX",
  "ISRC",
  "PERFORMER",
  "POSTGAP",
  "PREGAP",
  "REM",
  "SONGWRITER",
  "TITLE",
  "TRACK"
]);

const modeledCommands = new Set([
  "FILE",
  "INDEX",
  "PERFORMER",
  "POSTGAP",
  "PREGAP",
  "REM",
  "SONGWRITER",
  "TITLE",
  "TRACK"
]);

function cueCommand(line: string): string | undefined {
  return line.trim().match(/^([A-Z]+)(?:\s+|$)/)?.[1];
}

function emptyDocument(): CueDocument {
  return { remarks: [], files: [], tracks: [], unknownLines: [] };
}

function documentFingerprint(document: CueDocument): string {
  return JSON.stringify({
    title: document.title,
    performer: document.performer,
    songwriter: document.songwriter,
    remarks: document.remarks,
    files: document.files,
    tracks: document.tracks,
    unknownLines: document.unknownLines,
    preservedLines: document.preservedLines ?? []
  });
}

function formatTime(time: ITime | null | undefined): string | undefined {
  if (!time) {
    return undefined;
  }
  return [time.min, time.sec, time.frame].map((part) => String(part).padStart(2, "0")).join(":");
}

type ParserTrack = ITrack & { type?: string | null };

function parserDocument(cue: ICueSheet, rawText: string): CueDocument {
  const files = (cue.files ?? []).map((file) => ({
    path: file.name ?? "",
    ...(file.type ? { type: file.type } : {})
  }));
  const tracks: CueTrack[] = [];
  for (const [fileIndex, file] of (cue.files ?? []).entries()) {
    for (const sourceTrack of file.tracks ?? []) {
      const track = sourceTrack as ParserTrack;
      tracks.push({
        number: track.number ?? 0,
        ...(track.type ? { type: track.type } : {}),
        fileIndex,
        ...(track.title ? { title: track.title } : {}),
        ...(track.performer ? { performer: track.performer } : {}),
        ...(track.songWriter ? { songwriter: track.songWriter } : {}),
        ...(formatTime(track.pregap) ? { pregap: formatTime(track.pregap) } : {}),
        ...(formatTime(track.postgap) ? { postgap: formatTime(track.postgap) } : {}),
        indexes: (track.indexes ?? []).map((index) => ({
          number: index.number ?? 0,
          time: formatTime(index.time) ?? "00:00:00"
        }))
      });
    }
  }

  const preservedLines: CuePreservedLine[] = [];
  let fileIndex = -1;
  let activeTrackIndex: number | undefined;
  let nextTrackIndex = 0;
  let albumPosition = 0;
  let filePosition = 0;
  let trackPosition = 0;
  for (const [order, line] of rawText.split(/\r?\n/).entries()) {
    const command = cueCommand(line);
    if (command === "FILE") {
      fileIndex += 1;
      activeTrackIndex = undefined;
      filePosition = 0;
      continue;
    }
    if (command === "TRACK") {
      activeTrackIndex = nextTrackIndex;
      nextTrackIndex += 1;
      trackPosition = 0;
      continue;
    }
    if (line.trim() !== "" && command && modeledCommands.has(command)) {
      if (activeTrackIndex !== undefined) {
        trackPosition += 1;
      } else if (fileIndex >= 0) {
        filePosition += 1;
      } else {
        albumPosition += 1;
      }
      continue;
    }
    preservedLines.push(fileIndex < 0
      ? { text: line, scope: "album", order, position: albumPosition }
      : activeTrackIndex === undefined
        ? { text: line, scope: "file", fileIndex, order, position: filePosition }
        : { text: line, scope: "track", fileIndex, trackIndex: activeTrackIndex, order, position: trackPosition });
  }
  const unknownLines = preservedLines.filter((line) => line.text.trim() !== "").map((line) => line.text);
  const document: CueDocument = {
    ...(cue.title ? { title: cue.title } : {}),
    ...(cue.performer ? { performer: cue.performer } : {}),
    ...(cue.songWriter ? { songwriter: cue.songWriter } : {}),
    remarks: cue.rem ?? [],
    files,
    tracks,
    unknownLines,
    preservedLines
  };
  document.sourceText = rawText;
  document.sourceFingerprint = documentFingerprint(document);
  return document;
}

function validateRawTrackStructure(rawText: string): void {
  let activeTrack: { number: string; hasIndex01: boolean } | undefined;
  const finishTrack = (): void => {
    if (activeTrack && !activeTrack.hasIndex01) {
      throw new Error(`TRACK ${activeTrack.number} requires INDEX 01`);
    }
    activeTrack = undefined;
  };

  for (const line of rawText.split(/\r?\n/)) {
    const track = line.trim().match(/^TRACK\s+(\d+)\s+(\S+)/);
    if (track) {
      finishTrack();
      activeTrack = { number: track[1], hasIndex01: false };
      continue;
    }
    if (/^FILE(?:\s+|$)/.test(line.trim())) {
      finishTrack();
      continue;
    }
    if (activeTrack && /^INDEX\s+01(?:\s+|$)/.test(line.trim())) {
      activeTrack.hasIndex01 = true;
    }
  }
  finishTrack();
}

function parseWithCueParser(rawText: string, filePath: string): ICueSheet {
  validateRawTrackStructure(rawText);
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "music-id3-cue-parser-"));
  const temporaryPath = path.join(temporaryDirectory, path.basename(filePath) || "document.cue");
  const parserText = rawText.split(/\r?\n/).map((line) => {
    const command = cueCommand(line);
    return command && parserCommands.has(command) ? line : "";
  }).join("\n");
  try {
    writeFileSync(temporaryPath, parserText, "utf8");
    return parseCueFile(temporaryPath);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function resolvedReferences(document: CueDocument, filePath: string): string[] {
  return document.files
    .filter((file) => file.path)
    .map((file) => path.resolve(path.dirname(filePath), file.path.replace(/[\\/]+/g, path.sep)));
}

export function parseCue(rawText: string, filePath: string): CueDocumentState {
  try {
    const parsed = parserDocument(parseWithCueParser(rawText, filePath), rawText);
    return {
      path: filePath,
      encoding: "utf8",
      rawText,
      parsed,
      referencedFiles: resolvedReferences(parsed, filePath),
      missingReferencedFiles: []
    };
  } catch (error) {
    return {
      path: filePath,
      encoding: "utf8",
      rawText,
      parsed: emptyDocument(),
      referencedFiles: [],
      missingReferencedFiles: [],
      parseError: error instanceof Error ? error.message : String(error)
    };
  }
}

function quote(value: string): string {
  return `"${value.replaceAll('"', "''")}"`;
}

function canonicalCueText(document: CueDocument): string {
  const lines: string[] = [];
  const preserved = (scope: CuePreservedLine["scope"], fileIndex?: number, trackIndex?: number): CuePreservedLine[] => (
    document.preservedLines ?? []
  )
    .filter((line) => line.scope === scope && line.fileIndex === fileIndex && line.trackIndex === trackIndex)
    .sort((left, right) => left.order - right.order);
  const interleave = (structured: string[], retained: CuePreservedLine[]): string[] => {
    const result: string[] = [];
    for (let position = 0; position <= structured.length; position += 1) {
      result.push(...retained
        .filter((line) => Math.min(line.position, structured.length) === position)
        .map((line) => line.text));
      if (position < structured.length) {
        result.push(structured[position]);
      }
    }
    return result;
  };
  const albumLines: string[] = [];
  for (const remark of document.remarks) {
    albumLines.push(`REM ${remark}`);
  }
  if (document.songwriter) albumLines.push(`SONGWRITER ${quote(document.songwriter)}`);
  if (document.performer) albumLines.push(`PERFORMER ${quote(document.performer)}`);
  if (document.title) albumLines.push(`TITLE ${quote(document.title)}`);
  lines.push(...interleave(albumLines, preserved("album")));

  for (const [fileIndex, file] of document.files.entries()) {
    lines.push(`FILE ${quote(file.path)} ${file.type ?? "WAVE"}`);
    lines.push(...interleave([], preserved("file", fileIndex)));
    for (const [trackIndex, track] of document.tracks.entries()) {
      if ((track.fileIndex ?? 0) !== fileIndex) {
        continue;
      }
      lines.push(`  TRACK ${String(track.number).padStart(2, "0")} ${track.type ?? "AUDIO"}`);
      const trackLines: string[] = [];
      if (track.title) trackLines.push(`    TITLE ${quote(track.title)}`);
      if (track.performer) trackLines.push(`    PERFORMER ${quote(track.performer)}`);
      if (track.songwriter) trackLines.push(`    SONGWRITER ${quote(track.songwriter)}`);
      if (track.pregap) trackLines.push(`    PREGAP ${track.pregap}`);
      for (const index of track.indexes) {
        trackLines.push(`    INDEX ${String(index.number).padStart(2, "0")} ${index.time}`);
      }
      if (track.postgap) trackLines.push(`    POSTGAP ${track.postgap}`);
      lines.push(...interleave(trackLines, preserved("track", fileIndex, trackIndex)));
    }
  }
  if (!document.preservedLines) {
    lines.push(...document.unknownLines);
  }
  return lines.join("\n");
}

const cueTimePattern = /^(\d{2,}):([0-5]\d):([0-7]\d)$/;

function cueTimeFrames(value: string): number {
  const match = value.match(cueTimePattern);
  if (!match) {
    throw new Error(`Invalid CUE time: ${value}`);
  }
  return (Number(match[1]) * 60 + Number(match[2])) * 75 + Number(match[3]);
}

export function validateCueDocument(document: CueDocument): void {
  if (document.files.length === 0 || document.files.some((file) => file.path.trim() === "")) {
    throw new Error("CUE requires a non-empty FILE reference");
  }
  if (document.tracks.length === 0) {
    throw new Error("CUE requires at least one TRACK");
  }

  const lastIndexByFile = new Map<number, number>();
  let previousFileIndex = -1;
  for (const [position, track] of document.tracks.entries()) {
    if (!Number.isInteger(track.number) || track.number !== position + 1) {
      throw new Error("CUE TRACK numbers must be sequential starting at 1");
    }
    const fileIndex = track.fileIndex ?? 0;
    if (!Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex >= document.files.length) {
      throw new Error(`TRACK ${track.number} FILE index must be an integer in range`);
    }
    if (fileIndex < previousFileIndex) {
      throw new Error("TRACK FILE indices must be nondecreasing");
    }
    previousFileIndex = fileIndex;
    if (track.pregap) cueTimeFrames(track.pregap);
    if (track.postgap) cueTimeFrames(track.postgap);
    for (const index of track.indexes) {
      if (!Number.isInteger(index.number) || index.number < 0 || index.number > 99) {
        throw new Error(`TRACK ${track.number} has an invalid INDEX number`);
      }
      cueTimeFrames(index.time);
    }
    const index01 = track.indexes.find((index) => index.number === 1);
    if (!index01) {
      throw new Error(`TRACK ${track.number} requires INDEX 01`);
    }
    const frames = cueTimeFrames(index01.time);
    const previous = lastIndexByFile.get(fileIndex);
    if (previous !== undefined && frames <= previous) {
      throw new Error("INDEX 01 times must be strictly increasing within each FILE block");
    }
    lastIndexByFile.set(fileIndex, frames);
  }

  for (const line of document.preservedLines ?? []) {
    if (!Number.isInteger(line.order) || line.order < 0) {
      throw new Error("Preserved CUE lines require a non-negative order");
    }
    if (!Number.isInteger(line.position) || line.position < 0) {
      throw new Error("Preserved CUE lines require a non-negative position anchor");
    }
    const command = cueCommand(line.text);
    if (command && modeledCommands.has(command)) {
      throw new Error(`Structured directive ${command} cannot be stored as a preserved line`);
    }
    if (line.scope !== "album" && line.scope !== "file" && line.scope !== "track") {
      throw new Error("Invalid preserved-line anchor scope");
    }
    if (line.scope === "album") {
      if (line.fileIndex !== undefined || line.trackIndex !== undefined) {
        throw new Error("Album-scoped preserved lines cannot reference a FILE or TRACK");
      }
    } else if (line.scope === "file") {
      if (
        typeof line.fileIndex !== "number"
        || !Number.isInteger(line.fileIndex)
        || line.fileIndex < 0
        || line.fileIndex >= document.files.length
        || line.trackIndex !== undefined
      ) {
        throw new Error("Invalid preserved-line anchor for FILE scope");
      }
    } else if (
      typeof line.fileIndex !== "number"
      || typeof line.trackIndex !== "number"
      || !Number.isInteger(line.fileIndex)
      || !Number.isInteger(line.trackIndex)
      || line.fileIndex < 0
      || line.fileIndex >= document.files.length
      || line.trackIndex < 0
      || line.trackIndex >= document.tracks.length
      || (document.tracks[line.trackIndex].fileIndex ?? 0) !== line.fileIndex
    ) {
      throw new Error("Invalid preserved-line anchor for TRACK scope");
    }
  }
}

export function serializeCue(document: CueDocument, encoding: CueEncoding): Buffer {
  validateCueDocument(document);
  let text = canonicalCueText(document);
  if (document.sourceText !== undefined) {
    const sourceDocument = parserDocument(
      parseWithCueParser(document.sourceText, "submitted-source.cue"),
      document.sourceText
    );
    validateCueDocument(sourceDocument);
    if (documentFingerprint(sourceDocument) === documentFingerprint(document)) {
      text = document.sourceText;
    }
  }
  return encodeCueText(text, encoding);
}

async function pathExists(filePath: string, dependencies: CueServiceDependencies): Promise<boolean> {
  try {
    await dependencies.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function createCueService(overrides: Partial<CueServiceDependencies> = {}) {
  const dependencies: CueServiceDependencies = {
    access,
    copyFile,
    readFile,
    rename,
    unlink,
    writeFile,
    ...overrides
  };

  async function readCueFile(filePath: string): Promise<CueDocumentState> {
    const decoded = decodeCueBytes(await dependencies.readFile(filePath));
    const state = parseCue(decoded.text, filePath);
    const referencedFiles = resolvedReferences(state.parsed, filePath);
    const missingReferencedFiles: string[] = [];
    for (const referencedFile of referencedFiles) {
      if (!(await pathExists(referencedFile, dependencies))) {
        missingReferencedFiles.push(referencedFile);
      }
    }
    return {
      ...state,
      encoding: decoded.encoding,
      referencedFiles,
      missingReferencedFiles,
      ...(decoded.candidateEncodings ? { candidateEncodings: decoded.candidateEncodings } : {})
    };
  }

  async function saveCueFile(input: SaveCueInput): Promise<SaveCueResult> {
    const temporaryPath = `${input.path}.${randomUUID()}.tmp`;
    const temporaryPaths = new Set([temporaryPath]);
    try {
      let bytes: Buffer;
      if (input.rawText && input.rawText !== input.document.sourceText) {
        const rawState = parseCue(input.rawText, input.path);
        if (rawState.parseError) {
          throw new Error(rawState.parseError);
        }
        validateCueDocument(rawState.parsed);
        bytes = documentFingerprint(rawState.parsed) === documentFingerprint(input.document)
          ? encodeCueText(input.rawText, input.encoding)
          : serializeCue(input.document, input.encoding);
      } else {
        bytes = serializeCue(input.document, input.encoding);
      }

      const replacing = await pathExists(input.path, dependencies);
      await dependencies.writeFile(temporaryPath, bytes);
      let backupPath: string | undefined;
      let backupTemporaryPath: string | undefined;
      if (replacing) {
        backupPath = `${input.path}.bak`;
        backupTemporaryPath = `${backupPath}.${randomUUID()}.tmp`;
        temporaryPaths.add(backupTemporaryPath);
        await dependencies.copyFile(input.path, backupTemporaryPath);
      }
      await dependencies.rename(temporaryPath, input.path);
      temporaryPaths.delete(temporaryPath);
      if (backupPath && backupTemporaryPath) {
        try {
          await dependencies.rename(backupTemporaryPath, backupPath);
          temporaryPaths.delete(backupTemporaryPath);
        } catch (backupError) {
          try {
            await dependencies.rename(backupTemporaryPath, input.path);
            temporaryPaths.delete(backupTemporaryPath);
          } catch (rollbackError) {
            const backupMessage = backupError instanceof Error ? backupError.message : String(backupError);
            const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
            throw new Error(`${backupMessage}; failed to restore original CUE: ${rollbackMessage}`);
          }
          throw backupError;
        }
      }
      return { ok: true, path: input.path, ...(backupPath ? { backupPath } : {}) };
    } catch (error) {
      for (const filePath of temporaryPaths) {
        try {
          await dependencies.unlink(filePath);
        } catch {
          // A temporary file may not have been created or may already have been renamed.
        }
      }
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return { readCue: readCueFile, saveCue: saveCueFile };
}

const defaultCueService = createCueService();

export const readCue = defaultCueService.readCue;
export const saveCue = defaultCueService.saveCue;
