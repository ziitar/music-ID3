import { readdir, stat } from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import path from "node:path";
import type { AudioMetadata, LibraryItem } from "../../shared/types";
import { isSupportedAudioPath, wholeTrackStatus } from "./audio-format";
import { resolveCueFileReferences } from "./cue-file-references";
import { readCue } from "./cue-service";
import { readAudioMetadata } from "./tag-service";

export type ScanSummary = {
  items: LibraryItem[];
  errors: Array<{ path: string; error: string }>;
};

type ScannedPaths = {
  files: string[];
  audio: string[];
  cue: string[];
};

export type LibraryScannerDependencies = {
  readdir: (directory: string, options: { withFileTypes: true }) => Promise<Dirent[]>;
  readCue: typeof readCue;
  stat: (filePath: string) => Promise<Stats>;
  readAudioMetadata: (filePath: string) => Promise<AudioMetadata>;
};

function comparePaths(left: string, right: string): number {
  return left.localeCompare(right, "en", { sensitivity: "base" });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function walkDirectory(
  root: string,
  dependencies: LibraryScannerDependencies,
  errors: ScanSummary["errors"],
  signal?: AbortSignal
): Promise<ScannedPaths> {
  const files: string[] = [];
  const audio: string[] = [];
  const cue: string[] = [];

  async function visit(directory: string): Promise<void> {
    if (signal?.aborted) return;
    let entries: Dirent[];
    try {
      entries = await dependencies.readdir(directory, { withFileTypes: true });
    } catch (error) {
      errors.push({ path: directory, error: errorMessage(error) });
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, "en", { sensitivity: "base" }));
    for (const entry of entries) {
      if (signal?.aborted) return;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
        if (isSupportedAudioPath(entryPath)) {
          audio.push(entryPath);
        } else if (path.extname(entryPath).toLowerCase() === ".cue") {
          cue.push(entryPath);
        }
      }
    }
  }

  await visit(root);
  return { files, audio, cue };
}

export function createLibraryScanner(overrides: Partial<LibraryScannerDependencies> = {}) {
  const dependencies: LibraryScannerDependencies = {
    readdir,
    readCue,
    stat,
    readAudioMetadata,
    ...overrides
  };

  async function scanDirectory(root: string, onItem: (item: LibraryItem) => void, signal?: AbortSignal): Promise<ScanSummary> {
    const errors: ScanSummary["errors"] = [];
    const scanned = await walkDirectory(root, dependencies, errors, signal);
    const cueItems: LibraryItem[] = [];
    const cueByReferencedAudio = new Map<string, string>();

    for (const cuePath of scanned.cue) {
      if (signal?.aborted) break;
      try {
        const cueState = await dependencies.readCue(cuePath);
        const { referencedFiles, missingReferencedFiles } = await resolveCueFileReferences(
          cuePath,
          cueState.parsed.files.map((file) => file.path),
          scanned.files
        );
        for (const referencedPath of referencedFiles) {
          cueByReferencedAudio.set(path.normalize(referencedPath).toLocaleLowerCase("en-US"), cuePath);
        }
        const cueItem: LibraryItem = {
          kind: "cue",
          ...cueState,
          referencedFiles,
          missingReferencedFiles
        };
        if (cueState.parseError) {
          errors.push({ path: cuePath, error: cueState.parseError });
        }
        cueItems.push(cueItem);
        if (!signal?.aborted) onItem(cueItem);
      } catch (error) {
        errors.push({ path: cuePath, error: errorMessage(error) });
        const cueItem: LibraryItem = {
          kind: "cue",
          path: cuePath,
          encoding: "utf8",
          rawText: "",
          parsed: { remarks: [], files: [], tracks: [], unknownLines: [] },
          referencedFiles: [],
          missingReferencedFiles: [],
          parseError: errorMessage(error)
        };
        cueItems.push(cueItem);
        if (!signal?.aborted) onItem(cueItem);
      }
    }

    const audioItems: LibraryItem[] = [];
    for (const audioPath of scanned.audio) {
      if (signal?.aborted) break;
      let metadata: AudioMetadata;
      try {
        metadata = await dependencies.readAudioMetadata(audioPath);
      } catch (error) {
        const message = errorMessage(error);
        metadata = {
          common: {},
          raw: {},
          durationMs: 0,
          format: path.extname(audioPath).slice(1).toLowerCase(),
          errors: [message]
        };
      }
      for (const metadataError of metadata.errors ?? []) {
        errors.push({ path: audioPath, error: metadataError });
      }

      let sizeBytes = 0;
      try {
        sizeBytes = (await dependencies.stat(audioPath)).size;
      } catch (error) {
        const message = errorMessage(error);
        errors.push({ path: audioPath, error: message });
        metadata = { ...metadata, errors: [...(metadata.errors ?? []), message] };
      }

      const cuePath = cueByReferencedAudio.get(path.normalize(audioPath).toLocaleLowerCase("en-US"));
      const audioItem: LibraryItem = {
        kind: "audio",
        path: audioPath,
        fileName: path.basename(audioPath),
        extension: path.extname(audioPath).toLowerCase(),
        sizeBytes,
        durationMs: metadata.durationMs,
        metadata,
        cover: metadata.common.cover,
        cuePath,
        wholeTrackStatus: wholeTrackStatus(metadata.durationMs, Boolean(cuePath))
      };
      if (!signal?.aborted) {
        audioItems.push(audioItem);
        onItem(audioItem);
      }
    }

    return { items: [...audioItems, ...cueItems].sort((left, right) => comparePaths(left.path, right.path)), errors };
  }

  return { scanDirectory };
}

const defaultLibraryScanner = createLibraryScanner();

export const scanDirectory = defaultLibraryScanner.scanDirectory;
