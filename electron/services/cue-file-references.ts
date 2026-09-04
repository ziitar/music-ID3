import { access } from "node:fs/promises";
import path from "node:path";
import { readCue } from "./cue-service";

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
  const cue = await readCue(cuePath);
  return resolveCueFileReferences(
    cuePath,
    cue.parsed.files.map((file) => file.path),
    discoveredPaths
  );
}

export async function resolveCueFileReferences(
  cuePath: string,
  references: readonly string[],
  discoveredPaths: readonly string[] = []
): Promise<CueFileReferences> {
  const discoveredByCaseInsensitivePath = new Map(
    discoveredPaths.map((filePath) => [normalizedPath(filePath), filePath])
  );
  const referencedFiles: string[] = [];
  const missingReferencedFiles: string[] = [];

  for (const reference of references) {
    const resolved = resolveReference(cuePath, reference);
    const matchedPath = discoveredByCaseInsensitivePath.get(normalizedPath(resolved)) ?? resolved;
    referencedFiles.push(matchedPath);
    if (!discoveredByCaseInsensitivePath.has(normalizedPath(resolved)) && !(await exists(matchedPath))) {
      missingReferencedFiles.push(matchedPath);
    }
  }

  return { referencedFiles, missingReferencedFiles };
}
