import { access } from "node:fs/promises";
import path from "node:path";
import { parse } from "cue-parser";
import type { ICueSheet } from "cue-parser/lib/types";

export type CueFileReferences = {
  referencedFiles: string[];
  missingReferencedFiles: string[];
};

function normalizedPath(filePath: string): string {
  return path.normalize(filePath).toLocaleLowerCase("en-US");
}

function resolveReference(cuePath: string, reference: string): string {
  // CUE sheets conventionally use Windows separators, even when processed elsewhere.
  return path.resolve(path.dirname(cuePath), reference.replace(/[\\/]+/g, path.sep));
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readCueFileReferences(
  cuePath: string,
  discoveredPaths: readonly string[] = []
): Promise<CueFileReferences> {
  const discoveredByCaseInsensitivePath = new Map(
    discoveredPaths.map((filePath) => [normalizedPath(filePath), filePath])
  );
  const cue = parse(cuePath) as ICueSheet;
  const referencedFiles: string[] = [];
  const missingReferencedFiles: string[] = [];

  for (const file of cue.files ?? []) {
    if (!file.name) {
      continue;
    }
    const resolved = resolveReference(cuePath, file.name);
    const matchedPath = discoveredByCaseInsensitivePath.get(normalizedPath(resolved)) ?? resolved;
    referencedFiles.push(matchedPath);
    if (!discoveredByCaseInsensitivePath.has(normalizedPath(resolved)) && !(await exists(matchedPath))) {
      missingReferencedFiles.push(matchedPath);
    }
  }

  return { referencedFiles, missingReferencedFiles };
}
