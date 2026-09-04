import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { CueDocument, LibraryItem } from "../../shared/types";
import { isSupportedAudioPath, wholeTrackStatus } from "./audio-format";
import { readCueFileReferences } from "./cue-file-references";
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

function comparePaths(left: string, right: string): number {
  return left.localeCompare(right, "en", { sensitivity: "base" });
}

async function walkDirectory(root: string): Promise<ScannedPaths> {
  const files: string[] = [];
  const audio: string[] = [];
  const cue: string[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en", { sensitivity: "base" }));
    for (const entry of entries) {
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

function scannerCueDocument(referencedFiles: string[]): CueDocument {
  return {
    remarks: [],
    files: referencedFiles.map((filePath) => ({ path: filePath })),
    tracks: [],
    unknownLines: []
  };
}

export async function scanDirectory(root: string, onItem: (item: LibraryItem) => void): Promise<ScanSummary> {
  const errors: ScanSummary["errors"] = [];
  let scanned: ScannedPaths;
  try {
    scanned = await walkDirectory(root);
  } catch (error) {
    return { items: [], errors: [{ path: root, error: error instanceof Error ? error.message : String(error) }] };
  }

  const cueItems: LibraryItem[] = [];
  const cueByReferencedAudio = new Map<string, string>();
  for (const cuePath of scanned.cue) {
    try {
      const [{ referencedFiles, missingReferencedFiles }, rawText] = await Promise.all([
        readCueFileReferences(cuePath, scanned.files),
        readFile(cuePath, "utf8")
      ]);
      for (const referencedPath of referencedFiles) {
        cueByReferencedAudio.set(path.normalize(referencedPath).toLocaleLowerCase("en-US"), cuePath);
      }
      cueItems.push({
        kind: "cue",
        path: cuePath,
        encoding: "utf8",
        rawText,
        parsed: scannerCueDocument(referencedFiles),
        referencedFiles,
        missingReferencedFiles
      });
    } catch (error) {
      errors.push({ path: cuePath, error: error instanceof Error ? error.message : String(error) });
      cueItems.push({
        kind: "cue",
        path: cuePath,
        encoding: "utf8",
        rawText: "",
        parsed: scannerCueDocument([]),
        referencedFiles: [],
        missingReferencedFiles: []
      });
    }
  }

  const audioItems = await Promise.all(scanned.audio.map(async (audioPath): Promise<LibraryItem> => {
    const [metadata, fileStats] = await Promise.all([readAudioMetadata(audioPath), stat(audioPath)]);
    const cuePath = cueByReferencedAudio.get(path.normalize(audioPath).toLocaleLowerCase("en-US"));
    return {
      kind: "audio",
      path: audioPath,
      fileName: path.basename(audioPath),
      extension: path.extname(audioPath).toLowerCase(),
      sizeBytes: fileStats.size,
      durationMs: metadata.durationMs,
      metadata,
      cover: metadata.common.cover,
      cuePath,
      wholeTrackStatus: wholeTrackStatus(metadata.durationMs, Boolean(cuePath))
    };
  }));

  const items = [...audioItems, ...cueItems].sort((left, right) => comparePaths(left.path, right.path));
  for (const item of items) {
    onItem(item);
  }
  return { items, errors };
}
