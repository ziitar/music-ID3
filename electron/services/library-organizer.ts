import { constants } from "node:fs";
import { copyFile, lstat, mkdir, realpath, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CommonMetadata, OrganizePlan, OrganizePlanEntry, OrganizeResult } from "../../shared/types";

type OrganizeTrack = {
  sourcePath: string;
  metadata: CommonMetadata;
};

type Fingerprint = {
  size: number;
  mtimeMs: number;
};

type PreparedEntry = OrganizePlanEntry & {
  destinationPath: string;
  fingerprint: Fingerprint;
};

type PreparedPlan = {
  owner: string;
  targetRoot: string;
  entries: PreparedEntry[];
  expiresAt: number;
};

type OrganizerDependencies = {
  copyFile: typeof copyFile;
  lstat: typeof lstat;
  mkdir: typeof mkdir;
  realpath: typeof realpath;
  stat: typeof stat;
  unlink: typeof unlink;
  now: () => number;
};

const defaultDependencies: OrganizerDependencies = {
  copyFile,
  lstat,
  mkdir,
  realpath,
  stat,
  unlink,
  now: Date.now
};

const invalidWindowsCharacters = /[<>:"/\\|?*\u0000-\u001f]/g;
const reservedWindowsName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const artistSeparator = /\s*(?:、|,|;|&)\s*|\s+\/\s+/u;

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function sanitizeLibrarySegment(value: string): string {
  const normalized = value.normalize("NFKC").trim().replace(invalidWindowsCharacters, "_").replace(/[. ]+$/g, "").trim();
  if (!normalized) return "";
  const safe = reservedWindowsName.test(normalized) ? `_${normalized}` : normalized;
  return safe.slice(0, 120).replace(/[. ]+$/g, "");
}

export function formatLibraryArtist(value: string): string {
  const artists = value
    .normalize("NFKC")
    .split(artistSeparator)
    .map((artist) => sanitizeLibrarySegment(artist))
    .filter(Boolean);
  return sanitizeLibrarySegment(artists.join("&"));
}

export function organizedRelativePath(sourcePath: string, metadata: CommonMetadata): string | undefined {
  const artist = formatLibraryArtist(metadata.albumArtist?.trim() || metadata.artist?.trim() || "");
  const album = sanitizeLibrarySegment(metadata.album?.trim() || "");
  const title = sanitizeLibrarySegment(metadata.title?.trim() || "");
  const extension = path.extname(sourcePath).toLocaleLowerCase("en-US");
  if (!artist || !album || !title || !extension) return undefined;
  return path.join(artist, album, `${title}${extension}`);
}

function publicEntry(entry: PreparedEntry): OrganizePlanEntry {
  const { fingerprint: _fingerprint, ...result } = entry;
  return result;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createLibraryOrganizer(dependencies: OrganizerDependencies = defaultDependencies) {
  const prepared = new Map<string, PreparedPlan>();
  const planTtlMs = 10 * 60 * 1000;

  const prune = () => {
    const now = dependencies.now();
    for (const [token, plan] of prepared) if (plan.expiresAt <= now) prepared.delete(token);
  };

  const destinationStatus = async (sourcePath: string, destinationPath: string): Promise<Pick<OrganizePlanEntry, "status" | "reason">> => {
    if (pathKey(sourcePath) === pathKey(destinationPath)) return { status: "unchanged" };
    try {
      await dependencies.lstat(destinationPath);
      return { status: "blocked", reason: "A file already exists at the target path" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { status: "ready" };
    }
  };

  const ensureSafeParent = async (targetRoot: string, destinationPath: string): Promise<void> => {
    const parent = path.dirname(destinationPath);
    if (!isContained(targetRoot, parent)) throw new Error("Target path escapes the selected organize directory");
    await dependencies.mkdir(parent, { recursive: true });
    const canonicalParent = await dependencies.realpath(parent);
    if (!isContained(targetRoot, canonicalParent) || pathKey(canonicalParent) !== pathKey(parent)) {
      throw new Error("Target path contains a symbolic link or junction");
    }
  };

  return {
    clearOwner(owner: string): void {
      for (const [token, plan] of prepared) if (plan.owner === owner) prepared.delete(token);
    },

    async prepare(tracks: OrganizeTrack[], targetRoot: string, owner: string): Promise<OrganizePlan> {
      prune();
      const canonicalRoot = await dependencies.realpath(targetRoot);
      if (!(await dependencies.stat(canonicalRoot)).isDirectory()) throw new Error("Organize target must be a directory");
      const destinationKeys = new Set<string>();
      const entries: PreparedEntry[] = [];
      for (const track of tracks) {
        const fingerprintStat = await dependencies.stat(track.sourcePath);
        const relativePath = organizedRelativePath(track.sourcePath, track.metadata);
        if (!relativePath) {
          entries.push({
            sourcePath: track.sourcePath,
            destinationPath: "",
            status: "blocked",
            reason: "Title, album, and album artist or artist are required",
            fingerprint: { size: fingerprintStat.size, mtimeMs: fingerprintStat.mtimeMs }
          });
          continue;
        }
        const destinationPath = path.resolve(canonicalRoot, relativePath);
        if (!isContained(canonicalRoot, destinationPath)) throw new Error("Target path escapes the selected organize directory");
        const destinationKey = pathKey(destinationPath);
        const duplicate = destinationKeys.has(destinationKey);
        destinationKeys.add(destinationKey);
        const destination = duplicate
          ? { status: "blocked" as const, reason: "Multiple selected files resolve to the same target path" }
          : await destinationStatus(track.sourcePath, destinationPath);
        entries.push({
          sourcePath: track.sourcePath,
          destinationPath,
          relativePath,
          ...destination,
          fingerprint: { size: fingerprintStat.size, mtimeMs: fingerprintStat.mtimeMs }
        });
      }
      const confirmationToken = randomUUID();
      prepared.set(confirmationToken, { owner, targetRoot: canonicalRoot, entries, expiresAt: dependencies.now() + planTtlMs });
      return {
        confirmationToken,
        targetRoot: canonicalRoot,
        entries: entries.map(publicEntry),
        readyCount: entries.filter((entry) => entry.status === "ready").length
      };
    },

    async execute(confirmationToken: string, owner: string): Promise<OrganizeResult> {
      prune();
      const plan = prepared.get(confirmationToken);
      if (!plan || plan.owner !== owner) return { ok: false, error: "Organization preview expired or is invalid", rolledBack: true };
      prepared.delete(confirmationToken);
      if (plan.entries.some((entry) => entry.status === "blocked")) {
        return { ok: false, error: "Resolve blocked files before organizing", rolledBack: true };
      }
      const ready = plan.entries.filter((entry) => entry.status === "ready");
      const completed: PreparedEntry[] = [];
      let copied: PreparedEntry | undefined;
      try {
        const canonicalRoot = await dependencies.realpath(plan.targetRoot);
        if (pathKey(canonicalRoot) !== pathKey(plan.targetRoot)) throw new Error("Organize target changed after preview");
        for (const entry of ready) {
          const source = await dependencies.stat(entry.sourcePath);
          if (source.size !== entry.fingerprint.size || source.mtimeMs !== entry.fingerprint.mtimeMs) {
            throw new Error("A source file changed after preview");
          }
          await ensureSafeParent(plan.targetRoot, entry.destinationPath);
          await dependencies.copyFile(entry.sourcePath, entry.destinationPath, constants.COPYFILE_EXCL);
          copied = entry;
          const destination = await dependencies.stat(entry.destinationPath);
          if (destination.size !== source.size) throw new Error("Copied file size did not match the source");
          await dependencies.unlink(entry.sourcePath);
          completed.push(entry);
          copied = undefined;
        }
        return {
          ok: true,
          moved: completed.map((entry) => ({ sourcePath: entry.sourcePath, destinationPath: entry.destinationPath })),
          unchanged: plan.entries.filter((entry) => entry.status === "unchanged").map((entry) => entry.sourcePath)
        };
      } catch (error) {
        let rolledBack = true;
        if (copied) {
          try { await dependencies.unlink(copied.destinationPath); } catch { rolledBack = false; }
        }
        for (const entry of completed.reverse()) {
          try {
            await dependencies.copyFile(entry.destinationPath, entry.sourcePath, constants.COPYFILE_EXCL);
            await dependencies.unlink(entry.destinationPath);
          } catch {
            rolledBack = false;
          }
        }
        return { ok: false, error: message(error), rolledBack };
      }
    }
  };
}

export const libraryOrganizer = createLibraryOrganizer();
export type LibraryOrganizer = ReturnType<typeof createLibraryOrganizer>;
