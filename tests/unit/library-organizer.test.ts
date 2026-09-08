import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLibraryOrganizer, formatLibraryArtist, organizedRelativePath, sanitizeLibrarySegment } from "../../electron/services/library-organizer";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "music-id3-organizer-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("library organizer", () => {
  it("builds safe album-artist paths and falls back to the track artist", () => {
    expect(organizedRelativePath("D:/incoming/track.FLAC", {
      title: "Song: One?",
      artist: "Track Artist",
      albumArtist: "Album Artist",
      album: "Album / Deluxe"
    })).toBe(path.join("Album Artist", "Album _ Deluxe", "Song_ One_.flac"));
    expect(organizedRelativePath("D:/incoming/track.mp3", {
      title: "Song",
      artist: "Track Artist",
      album: "Album"
    })).toBe(path.join("Track Artist", "Album", "Song.mp3"));
    expect(sanitizeLibrarySegment("CON")).toBe("_CON");
  });

  it("joins multi-value album artists with ampersands", () => {
    expect(formatLibraryArtist("Artist One、 Artist Two，Artist Three; Artist Four / Artist Five＆Artist Six"))
      .toBe("Artist One&Artist Two&Artist Three&Artist Four&Artist Five&Artist Six");
    expect(organizedRelativePath("D:/incoming/track.flac", {
      title: "Song",
      albumArtist: "Artist One、Artist Two",
      album: "Album"
    })).toBe(path.join("Artist One&Artist Two", "Album", "Song.flac"));
    expect(formatLibraryArtist("AC/DC")).toBe("AC_DC");
  });

  it("previews and executes a confirmed move without overwriting", async () => {
    const root = await temporaryDirectory();
    const target = await temporaryDirectory();
    const sourcePath = path.join(root, "incoming.flac");
    await writeFile(sourcePath, "audio");
    const organizer = createLibraryOrganizer();
    const plan = await organizer.prepare([{
      sourcePath,
      metadata: { title: "Track", artist: "Artist", album: "Album" }
    }], target, "renderer-1");

    expect(plan.entries[0]).toMatchObject({
      status: "ready",
      relativePath: path.join("Artist", "Album", "Track.flac")
    });
    const result = await organizer.execute(plan.confirmationToken, "renderer-1");

    expect(result).toMatchObject({ ok: true, moved: [{ sourcePath }] });
    if (!result.ok) throw new Error(result.error);
    await expect(readFile(result.moved[0].destinationPath, "utf8")).resolves.toBe("audio");
    await expect(stat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(organizer.execute(plan.confirmationToken, "renderer-1")).resolves.toMatchObject({ ok: false });
  });

  it("blocks incomplete metadata and existing or duplicate targets", async () => {
    const root = await temporaryDirectory();
    const target = await temporaryDirectory();
    const first = path.join(root, "first.mp3");
    const second = path.join(root, "second.mp3");
    const incomplete = path.join(root, "incomplete.mp3");
    await Promise.all([writeFile(first, "one"), writeFile(second, "two"), writeFile(incomplete, "three")]);
    const existing = path.join(target, "Artist", "Album");
    await mkdir(existing, { recursive: true });
    await writeFile(path.join(existing, "Same.mp3"), "existing");
    const organizer = createLibraryOrganizer();
    const plan = await organizer.prepare([
      { sourcePath: first, metadata: { title: "Same", artist: "Artist", album: "Album" } },
      { sourcePath: second, metadata: { title: "Same", artist: "Artist", album: "Album" } },
      { sourcePath: incomplete, metadata: { title: "Missing album", artist: "Artist" } }
    ], target, "renderer-1");

    expect(plan.readyCount).toBe(0);
    expect(plan.entries.map((entry) => entry.status)).toEqual(["blocked", "blocked", "blocked"]);
    await expect(organizer.execute(plan.confirmationToken, "renderer-1")).resolves.toEqual({
      ok: false,
      error: "Resolve blocked files before organizing",
      rolledBack: true
    });
  });

  it("restores completed moves when a later source cannot be removed", async () => {
    const root = await temporaryDirectory();
    const target = await temporaryDirectory();
    const first = path.join(root, "first.mp3");
    const second = path.join(root, "second.mp3");
    await Promise.all([writeFile(first, "one"), writeFile(second, "two")]);
    let failed = false;
    const organizer = createLibraryOrganizer({
      copyFile,
      lstat,
      mkdir,
      realpath,
      stat,
      unlink: async (filePath) => {
        if (!failed && path.resolve(filePath) === path.resolve(second)) {
          failed = true;
          throw new Error("locked source");
        }
        await unlink(filePath);
      },
      now: Date.now
    });
    const plan = await organizer.prepare([
      { sourcePath: first, metadata: { title: "First", artist: "Artist", album: "Album" } },
      { sourcePath: second, metadata: { title: "Second", artist: "Artist", album: "Album" } }
    ], target, "renderer-1");

    const result = await organizer.execute(plan.confirmationToken, "renderer-1");

    expect(result).toEqual({ ok: false, error: "locked source", rolledBack: true });
    await expect(readFile(first, "utf8")).resolves.toBe("one");
    await expect(readFile(second, "utf8")).resolves.toBe("two");
  });
});
