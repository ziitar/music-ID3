import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  access,
  link,
  lstat,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { mkdtempSync, rmSync, writeFileSync, type Stats } from "node:fs";
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
  PrepareCueSaveInput,
  SaveCueInput,
  SaveCueResult
} from "../../shared/types";
import { decodeCueBytes, encodeCueText } from "./cue-encoding";

type CueServiceDependencies = {
  access: typeof access;
  link: typeof link;
  lstat: typeof lstat;
  readFile: typeof readFile;
  realpath: typeof realpath;
  rename: typeof rename;
  stat: typeof stat;
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
    .map((file) => path.resolve(
      path.dirname(filePath),
      process.platform === "win32" ? file.path : file.path.replace(/\\/g, path.sep)
    ));
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
  if (value.includes('"')) {
    throw new Error("Structured CUE values cannot contain a double quote; use raw mode to resolve the source text without data corruption");
  }
  return `"${value}"`;
}

type ModeledLine = { key: string; text: string };

function albumModeledLines(document: CueDocument): ModeledLine[] {
  const lines = document.remarks.map((remark, index) => ({ key: `rem:${index}`, text: `REM ${remark}` }));
  if (document.songwriter) lines.push({ key: "songwriter", text: `SONGWRITER ${quote(document.songwriter)}` });
  if (document.performer) lines.push({ key: "performer", text: `PERFORMER ${quote(document.performer)}` });
  if (document.title) lines.push({ key: "title", text: `TITLE ${quote(document.title)}` });
  return lines;
}

function trackModeledLines(track: CueTrack): ModeledLine[] {
  const lines: ModeledLine[] = [];
  if (track.title) lines.push({ key: "title", text: `    TITLE ${quote(track.title)}` });
  if (track.performer) lines.push({ key: "performer", text: `    PERFORMER ${quote(track.performer)}` });
  if (track.songwriter) lines.push({ key: "songwriter", text: `    SONGWRITER ${quote(track.songwriter)}` });
  if (track.pregap) lines.push({ key: "pregap", text: `    PREGAP ${track.pregap}` });
  for (const index of track.indexes) {
    lines.push({
      key: `index:${index.number}`,
      text: `    INDEX ${String(index.number).padStart(2, "0")} ${index.time}`
    });
  }
  if (track.postgap) lines.push({ key: "postgap", text: `    POSTGAP ${track.postgap}` });
  return lines;
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
        .filter((line) => line.position === position)
        .map((line) => line.text));
      if (position < structured.length) {
        result.push(structured[position]);
      }
    }
    return result;
  };
  const albumLines = albumModeledLines(document).map((line) => line.text);
  lines.push(...interleave(albumLines, preserved("album")));

  for (const [fileIndex, file] of document.files.entries()) {
    lines.push(`FILE ${quote(file.path)} ${file.type ?? "WAVE"}`);
    lines.push(...interleave([], preserved("file", fileIndex)));
    for (const [trackIndex, track] of document.tracks.entries()) {
      if ((track.fileIndex ?? 0) !== fileIndex) {
        continue;
      }
      lines.push(`  TRACK ${String(track.number).padStart(2, "0")} ${track.type ?? "AUDIO"}`);
      const trackLines = trackModeledLines(track).map((line) => line.text);
      lines.push(...interleave(trackLines, preserved("track", fileIndex, trackIndex)));
    }
  }
  if (!document.preservedLines) {
    lines.push(...document.unknownLines);
  }
  return lines.join("\n");
}

type SourceScope = "album" | "file" | "track";
type SourceSegment =
  | { kind: "scope"; scope: SourceScope; fileIndex?: number; trackIndex?: number; lines: string[] }
  | { kind: "file"; fileIndex: number }
  | { kind: "track"; fileIndex: number; trackIndex: number };

type ScopeLayoutLengths = { album: number; files: number[]; tracks: number[] };

function sourceSegments(sourceText: string): SourceSegment[] {
  const segments: SourceSegment[] = [{ kind: "scope", scope: "album", lines: [] }];
  let current = segments[0] as Extract<SourceSegment, { kind: "scope" }>;
  let fileIndex = -1;
  let trackIndex = -1;
  for (const line of sourceText.split(/\r?\n/)) {
    const command = cueCommand(line);
    if (command === "FILE") {
      fileIndex += 1;
      segments.push({ kind: "file", fileIndex });
      current = { kind: "scope", scope: "file", fileIndex, lines: [] };
      segments.push(current);
    } else if (command === "TRACK") {
      trackIndex += 1;
      segments.push({ kind: "track", fileIndex, trackIndex });
      current = { kind: "scope", scope: "track", fileIndex, trackIndex, lines: [] };
      segments.push(current);
    } else {
      current.lines.push(line);
    }
  }
  return segments;
}

function sourceLayoutLengths(sourceText: string): ScopeLayoutLengths {
  const layout: ScopeLayoutLengths = { album: 0, files: [], tracks: [] };
  for (const segment of sourceSegments(sourceText)) {
    if (segment.kind !== "scope") {
      continue;
    }
    const length = segment.lines.filter((line) => {
      const command = cueCommand(line);
      return command !== undefined && modeledCommands.has(command);
    }).length;
    if (segment.scope === "album") {
      layout.album = length;
    } else if (segment.scope === "file") {
      layout.files[segment.fileIndex as number] = length;
    } else {
      layout.tracks[segment.trackIndex as number] = length;
    }
  }
  return layout;
}

function structuredLayoutLengths(document: CueDocument): ScopeLayoutLengths {
  return {
    album: albumModeledLines(document).length,
    files: document.files.map(() => 0),
    tracks: document.tracks.map((track) => trackModeledLines(track).length)
  };
}

function sourceTopologyMatches(source: CueDocument, submitted: CueDocument): boolean {
  return source.files.length === submitted.files.length
    && source.tracks.length === submitted.tracks.length
    && source.tracks.every(
      (track, index) => (track.fileIndex ?? 0) === (submitted.tracks[index].fileIndex ?? 0)
    );
}

function overlayScope(sourceLines: string[], scope: SourceScope, desired: ModeledLine[]): string[] {
  let remIndex = 0;
  const keyForLine = (line: string): string | undefined => {
    const command = cueCommand(line);
    if (scope === "album") {
      if (command === "REM") return `rem:${remIndex++}`;
      if (command === "SONGWRITER") return "songwriter";
      if (command === "PERFORMER") return "performer";
      if (command === "TITLE") return "title";
      return undefined;
    }
    if (scope !== "track") {
      return undefined;
    }
    if (command === "TITLE") return "title";
    if (command === "PERFORMER") return "performer";
    if (command === "SONGWRITER") return "songwriter";
    if (command === "PREGAP") return "pregap";
    if (command === "POSTGAP") return "postgap";
    if (command === "INDEX") {
      const number = line.trim().match(/^INDEX\s+(\d+)/)?.[1];
      return number === undefined ? undefined : `index:${Number(number)}`;
    }
    return undefined;
  };

  type OverlayEntry = { kind: "modeled"; key: string; text: string; desiredOrder: number } | { kind: "preserved"; text: string };
  const desiredByKey = new Map(desired.map((line, index) => [line.key, { ...line, desiredOrder: index }]));
  const used = new Set<string>();
  const entries: OverlayEntry[] = [];
  for (const line of sourceLines) {
    const key = keyForLine(line);
    if (key === undefined) {
      entries.push({ kind: "preserved", text: line });
      continue;
    }
    const replacement = desiredByKey.get(key);
    if (replacement && !used.has(key)) {
      entries.push({ kind: "modeled", key, text: replacement.text, desiredOrder: replacement.desiredOrder });
      used.add(key);
    }
  }

  for (const [desiredOrder, line] of desired.entries()) {
    if (used.has(line.key)) {
      continue;
    }
    const before = entries.findIndex((entry) => entry.kind === "modeled" && entry.desiredOrder > desiredOrder);
    if (before >= 0) {
      entries.splice(before, 0, { kind: "modeled", key: line.key, text: line.text, desiredOrder });
    } else {
      let after = -1;
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        if (entries[index].kind === "modeled") {
          after = index + 1;
          break;
        }
      }
      entries.splice(after < 0 ? entries.length : after, 0, {
        kind: "modeled",
        key: line.key,
        text: line.text,
        desiredOrder
      });
    }
    used.add(line.key);
  }
  return entries.map((entry) => entry.text);
}

function overlayTrustedSource(sourceText: string, source: CueDocument, submitted: CueDocument): string | undefined {
  if (!sourceTopologyMatches(source, submitted)) {
    return undefined;
  }

  const output: string[] = [];
  for (const segment of sourceSegments(sourceText)) {
    if (segment.kind === "file") {
      const file = submitted.files[segment.fileIndex];
      output.push(`FILE ${quote(file.path)} ${file.type ?? "WAVE"}`);
    } else if (segment.kind === "track") {
      const track = submitted.tracks[segment.trackIndex];
      output.push(`  TRACK ${String(track.number).padStart(2, "0")} ${track.type ?? "AUDIO"}`);
    } else if (segment.scope === "album") {
      output.push(...overlayScope(segment.lines, "album", albumModeledLines(submitted)));
    } else if (segment.scope === "file") {
      output.push(...segment.lines);
    } else {
      output.push(...overlayScope(segment.lines, "track", trackModeledLines(submitted.tracks[segment.trackIndex as number])));
    }
  }
  return output.join(sourceText.includes("\r\n") ? "\r\n" : "\n");
}

const cueTimePattern = /^(\d{2,}):([0-5]\d):([0-7]\d)$/;

function cueTimeFrames(value: string): number {
  const match = value.match(cueTimePattern);
  if (!match) {
    throw new Error(`Invalid CUE time: ${value}`);
  }
  return (Number(match[1]) * 60 + Number(match[2])) * 75 + Number(match[3]);
}

export function validateCueDocument(document: CueDocument, layout = structuredLayoutLengths(document)): void {
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
    const indexNumbers = new Set<number>();
    for (const index of track.indexes) {
      if (!Number.isInteger(index.number) || index.number < 0 || index.number > 99) {
        throw new Error(`TRACK ${track.number} has an invalid INDEX number`);
      }
      if (indexNumbers.has(index.number)) {
        throw new Error(
          `TRACK ${track.number} has duplicate INDEX ${String(index.number).padStart(2, "0")}`
        );
      }
      indexNumbers.add(index.number);
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
    const positionLimit = line.scope === "album"
      ? layout.album
      : line.scope === "file"
        ? layout.files[line.fileIndex as number]
        : layout.tracks[line.trackIndex as number];
    if (line.position > positionLimit) {
      throw new Error("Preserved CUE lines require a non-negative position anchor within their scope");
    }
  }
}

export function serializeCue(document: CueDocument, encoding: CueEncoding): Buffer {
  let text: string;
  if (document.sourceText !== undefined) {
    const sourceLayout = sourceLayoutLengths(document.sourceText);
    const sourceDocument = parserDocument(
      parseWithCueParser(document.sourceText, "submitted-source.cue"),
      document.sourceText
    );
    validateCueDocument(sourceDocument, sourceLayout);
    const topologyMatches = sourceTopologyMatches(sourceDocument, document);
    validateCueDocument(document, topologyMatches ? sourceLayout : undefined);
    if (documentFingerprint(sourceDocument) === documentFingerprint(document)) {
      text = document.sourceText;
    } else if (topologyMatches) {
      text = overlayTrustedSource(document.sourceText, sourceDocument, document) ?? canonicalCueText(document);
    } else {
      text = canonicalCueText(document);
    }
  } else {
    validateCueDocument(document);
    text = canonicalCueText(document);
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

function cueBytesForSave(input: PrepareCueSaveInput): Buffer {
  if (input.rawText && input.rawText !== input.document.sourceText) {
    const rawState = parseCue(input.rawText, input.path);
    if (rawState.parseError) throw new Error(rawState.parseError);
    validateCueDocument(rawState.parsed);
    return documentFingerprint(rawState.parsed) === documentFingerprint(input.document)
      ? encodeCueText(input.rawText, input.encoding)
      : serializeCue(input.document, input.encoding);
  }
  return serializeCue(input.document, input.encoding);
}

export function cueDocumentForSave(input: PrepareCueSaveInput): CueDocument {
  const decoded = decodeCueBytes(cueBytesForSave(input), input.encoding);
  const state = parseCue(decoded.text, input.path);
  if (state.parseError) throw new Error(state.parseError);
  validateCueDocument(state.parsed);
  return state.parsed;
}

function normalizedSavePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

const MAX_TRACKED_CUE_SAVES = 512;

export function createCueService(overrides: Partial<CueServiceDependencies> = {}) {
  const dependencies: CueServiceDependencies = {
    access,
    link,
    lstat,
    readFile,
    realpath,
    rename,
    stat,
    unlink,
    writeFile,
    ...overrides
  };
  const confirmationSecret = randomBytes(32);
  const issuedConfirmations = new Set<string>();
  const completedSaves = new Map<string, Promise<SaveCueResult>>();
  const inFlightSaves = new Map<string, Promise<SaveCueResult>>();
  const pathOperations = new Map<string, Promise<void>>();

  async function assertCanonicalSavePath(filePath: string): Promise<void> {
    const expectedPath = path.resolve(filePath);
    try {
      const canonicalPath = await dependencies.realpath(expectedPath);
      if (normalizedSavePath(canonicalPath) !== normalizedSavePath(expectedPath)) {
        throw new Error("CUE save path changed after canonical authorization");
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await dependencies.lstat(expectedPath);
      throw new Error("CUE save path changed to an unresolved symbolic link");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const expectedParent = path.dirname(expectedPath);
    const canonicalParent = await dependencies.realpath(expectedParent);
    if (normalizedSavePath(canonicalParent) !== normalizedSavePath(expectedParent)) {
      throw new Error("CUE save parent changed after canonical authorization");
    }
    if (!(await dependencies.stat(canonicalParent)).isDirectory()) {
      throw new Error("CUE save parent must remain a directory");
    }
  }

  const statFingerprint = (value: Stats): string => [
    value.dev,
    value.ino,
    value.mode,
    value.size,
    value.mtimeMs,
    value.birthtimeMs
  ].join(":");

  const statIdentity = (value: Stats): string => [value.dev, value.ino, value.mode].join(":");

  async function fileRevision(filePath: string): Promise<Buffer> {
    try {
      const before = await dependencies.stat(filePath);
      const contents = await dependencies.readFile(filePath);
      const after = await dependencies.stat(filePath);
      return createHash("sha256")
        .update("present\0")
        .update(statFingerprint(before))
        .update("\0")
        .update(contents)
        .update("\0")
        .update(statFingerprint(after))
        .digest();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const canonicalParent = await dependencies.realpath(path.dirname(filePath));
      const parentStats = await dependencies.stat(canonicalParent);
      return createHash("sha256")
        .update("missing\0")
        .update(normalizedSavePath(canonicalParent))
        .update("\0")
        .update(statIdentity(parentStats))
        .digest();
    }
  }

  async function assertConfirmedRevision(filePath: string, expectedRevision: Buffer): Promise<void> {
    const currentRevision = await fileRevision(filePath);
    if (!timingSafeEqual(currentRevision, expectedRevision)) {
      throw new Error("CUE file changed since confirmation; review it before saving again");
    }
  }

  function confirmationMac(scope: string, filePath: string, bytes: Buffer, revision: Buffer, nonce: Buffer): Buffer {
    const intent = createHash("sha256").update(bytes).digest();
    return createHmac("sha256", confirmationSecret)
      .update("music-id3-cue-save-v2\0")
      .update(scope)
      .update("\0")
      .update(normalizedSavePath(filePath))
      .update("\0")
      .update(intent)
      .update(revision)
      .update(nonce)
      .digest();
  }

  async function prepareCueSave(input: PrepareCueSaveInput, confirmationScope = "local-main"): Promise<string> {
    if (confirmationScope.trim() === "") throw new Error("CUE save confirmation scope is unavailable");
    await assertCanonicalSavePath(input.path);
    const bytes = cueBytesForSave(input);
    const revision = await fileRevision(input.path);
    const nonce = randomBytes(16);
    const mac = confirmationMac(confirmationScope, input.path, bytes, revision, nonce);
    const token = `v2.${nonce.toString("base64url")}.${revision.toString("base64url")}.${mac.toString("base64url")}`;
    if (issuedConfirmations.size >= MAX_TRACKED_CUE_SAVES) {
      const oldest = issuedConfirmations.values().next().value as string | undefined;
      if (oldest) issuedConfirmations.delete(oldest);
    }
    issuedConfirmations.add(token);
    return token;
  }

  function confirmedRevision(input: SaveCueInput, confirmationScope: string, bytes: Buffer): Buffer | undefined {
    const parts = input.confirmationToken.split(".");
    if (parts.length !== 4 || parts[0] !== "v2") return undefined;
    const nonce = Buffer.from(parts[1], "base64url");
    const revision = Buffer.from(parts[2], "base64url");
    const suppliedMac = Buffer.from(parts[3], "base64url");
    if (nonce.length !== 16 || revision.length !== 32 || suppliedMac.length !== 32) return undefined;
    const expectedMac = confirmationMac(confirmationScope, input.path, bytes, revision, nonce);
    return timingSafeEqual(suppliedMac, expectedMac) ? revision : undefined;
  }

  async function readCueFile(filePath: string, sourceEncoding?: CueEncoding): Promise<CueDocumentState> {
    const decoded = decodeCueBytes(await dependencies.readFile(filePath), sourceEncoding);
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

  async function saveCueFileOnce(input: SaveCueInput, bytes: Buffer, expectedRevision: Buffer): Promise<SaveCueResult> {
    const temporaryPath = `${input.path}.${randomUUID()}.tmp`;
    const temporaryPaths = new Set([temporaryPath]);
    let retainedRecoveryPath: string | undefined;
    try {
      await assertCanonicalSavePath(input.path);
      const replacing = await pathExists(input.path, dependencies);
      await assertCanonicalSavePath(input.path);
      await assertConfirmedRevision(input.path, expectedRevision);
      await dependencies.writeFile(temporaryPath, bytes);
      let backupPath: string | undefined;
      let backupTemporaryPath: string | undefined;
      if (replacing) {
        await assertCanonicalSavePath(input.path);
        await assertConfirmedRevision(input.path, expectedRevision);
        backupPath = `${input.path}.bak`;
        backupTemporaryPath = `${backupPath}.${randomUUID()}.tmp`;
        temporaryPaths.add(backupTemporaryPath);
        await dependencies.rename(input.path, backupTemporaryPath);
        temporaryPaths.delete(backupTemporaryPath);
        retainedRecoveryPath = backupTemporaryPath;
        const displacedRevision = await fileRevision(backupTemporaryPath);
        if (!timingSafeEqual(displacedRevision, expectedRevision)) {
          try {
            await dependencies.link(backupTemporaryPath, input.path);
            await dependencies.unlink(backupTemporaryPath);
            retainedRecoveryPath = undefined;
          } catch (restoreError) {
            const restoreMessage = restoreError instanceof Error ? restoreError.message : String(restoreError);
            throw new Error(`CUE file changed during save; failed to restore it: ${restoreMessage}`);
          }
          throw new Error("CUE file changed since confirmation; review it before saving again");
        }
        await assertCanonicalSavePath(input.path);
      } else {
        await assertCanonicalSavePath(input.path);
        await assertConfirmedRevision(input.path, expectedRevision);
      }
      try {
        await dependencies.link(temporaryPath, input.path);
      } catch (publishError) {
        if (backupTemporaryPath && (publishError as NodeJS.ErrnoException).code !== "EEXIST") {
          try {
            await dependencies.link(backupTemporaryPath, input.path);
            await dependencies.unlink(backupTemporaryPath);
            retainedRecoveryPath = undefined;
          } catch (restoreError) {
            const publishMessage = publishError instanceof Error ? publishError.message : String(publishError);
            const restoreMessage = restoreError instanceof Error ? restoreError.message : String(restoreError);
            throw new Error(`${publishMessage}; failed to restore original CUE: ${restoreMessage}`);
          }
        }
        throw publishError;
      }
      if (backupPath && backupTemporaryPath) {
        try {
          await dependencies.rename(backupTemporaryPath, backupPath);
          retainedRecoveryPath = undefined;
        } catch (backupError) {
          const backupMessage = backupError instanceof Error ? backupError.message : String(backupError);
          const rollbackTemporaryPath = `${input.path}.${randomUUID()}.rollback.tmp`;
          let destinationChanged = false;
          let quarantinedDestination = false;
          let rollbackError: unknown;
          try {
            await dependencies.rename(input.path, rollbackTemporaryPath);
            quarantinedDestination = true;
            destinationChanged = !(await dependencies.readFile(rollbackTemporaryPath)).equals(bytes);
            if (destinationChanged) {
              await dependencies.link(rollbackTemporaryPath, input.path);
            } else {
              await dependencies.link(backupTemporaryPath, input.path);
              retainedRecoveryPath = undefined;
              try {
                await dependencies.unlink(backupTemporaryPath);
              } catch {
                // The original is already restored at the destination.
              }
            }
            quarantinedDestination = false;
            try {
              await dependencies.unlink(rollbackTemporaryPath);
            } catch {
              // The quarantined entry is redundant after its safe restoration.
            }
          } catch (error) {
            rollbackError = error;
            if (quarantinedDestination) {
              try {
                await dependencies.link(rollbackTemporaryPath, input.path);
                quarantinedDestination = false;
                try {
                  await dependencies.unlink(rollbackTemporaryPath);
                } catch {
                  // The destination is restored; a redundant hard link may remain.
                }
              } catch {
                // Preserve the quarantined entry when the destination is occupied or unavailable.
              }
            }
          }
          if (rollbackError) {
            const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
            const quarantineMessage = quarantinedDestination ? ` Current destination retained at ${rollbackTemporaryPath}.` : "";
            throw new Error(`${backupMessage}; safe rollback failed: ${rollbackMessage}.${quarantineMessage}`);
          }
          if (destinationChanged) throw new Error(`${backupMessage}; destination changed during backup publication`);
          throw backupError;
        }
      }
      temporaryPaths.delete(temporaryPath);
      try {
        await dependencies.unlink(temporaryPath);
      } catch {
        // Destination and backup publication are already committed; this hard link is redundant.
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
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: retainedRecoveryPath && !message.includes(retainedRecoveryPath)
          ? `${message}. Original CUE recovery copy retained at ${retainedRecoveryPath}`
          : message
      };
    }
  }

  function saveCueFile(input: SaveCueInput, confirmationScope = "local-main"): Promise<SaveCueResult> {
    if (typeof input.confirmationToken !== "string" || input.confirmationToken.trim() === "") {
      return Promise.resolve({ ok: false, error: "CUE save requires a confirmation token" });
    }
    let bytes: Buffer;
    try {
      bytes = cueBytesForSave(input);
    } catch (error) {
      return Promise.resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    const expectedRevision = confirmedRevision(input, confirmationScope, bytes);
    if (!expectedRevision) return Promise.resolve({ ok: false, error: "Invalid CUE save confirmation" });
    const savePathKey = normalizedSavePath(input.path);
    const key = `${confirmationScope}\0${savePathKey}\0${input.confirmationToken}`;
    const existing = inFlightSaves.get(key) ?? completedSaves.get(key);
    if (existing) return existing;
    if (!issuedConfirmations.has(input.confirmationToken)) {
      return Promise.resolve({ ok: false, error: "CUE save confirmation is invalid, expired, or already used" });
    }
    if (inFlightSaves.size >= MAX_TRACKED_CUE_SAVES) {
      return Promise.resolve({ ok: false, error: "Too many CUE saves are already in progress" });
    }
    issuedConfirmations.delete(input.confirmationToken);
    const execute = async (): Promise<SaveCueResult> => {
      try {
        await assertCanonicalSavePath(input.path);
        await assertConfirmedRevision(input.path, expectedRevision);
        return saveCueFileOnce(input, bytes, expectedRevision);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    };
    const prior = pathOperations.get(savePathKey);
    const operation = prior ? prior.then(execute, execute) : execute();
    const queued = operation.then(() => undefined, () => undefined);
    pathOperations.set(savePathKey, queued);
    void queued.then(() => {
      if (pathOperations.get(savePathKey) === queued) pathOperations.delete(savePathKey);
    });
    inFlightSaves.set(key, operation);
    const rememberCompletion = () => {
      if (inFlightSaves.get(key) === operation) inFlightSaves.delete(key);
      completedSaves.set(key, operation);
      if (completedSaves.size > MAX_TRACKED_CUE_SAVES) {
        const oldest = completedSaves.keys().next().value as string | undefined;
        if (oldest) completedSaves.delete(oldest);
      }
    };
    void operation.then(rememberCompletion, rememberCompletion);
    return operation;
  }

  return { readCue: readCueFile, prepareCueSave, saveCue: saveCueFile };
}

const defaultCueService = createCueService();

export const readCue = defaultCueService.readCue;
export const prepareCueSave = defaultCueService.prepareCueSave;
export const saveCue = defaultCueService.saveCue;
