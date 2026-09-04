import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerIpcHandlers } from "../../electron/ipc/register-ipc";
import { ipcChannels, isIpcChannel } from "../../shared/ipc";
import type { CueDocument } from "../../shared/types";

const temporaryDirectories: string[] = [];

async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "music-id3-ipc-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("IPC contracts", () => {
  it("exposes only the approved invoke channels and scan progress event", () => {
    expect(ipcChannels).toEqual({
      selectDirectory: "music-id3:select-directory",
      scanDirectory: "music-id3:scan-directory",
      cancelScan: "music-id3:cancel-scan",
      readAudio: "music-id3:read-audio",
      writeAudio: "music-id3:write-audio",
      readCue: "music-id3:read-cue",
      saveCue: "music-id3:save-cue",
      previewCue: "music-id3:preview-cue",
      buildCandidateCue: "music-id3:build-candidate-cue",
      searchMetadata: "music-id3:search-metadata",
      getMetadataCandidate: "music-id3:get-metadata-candidate",
      setProviderCookie: "music-id3:set-provider-cookie",
      testProviderCookie: "music-id3:test-provider-cookie",
      getProviderCookieStatus: "music-id3:get-provider-cookie-status",
      clearOnlineCache: "music-id3:clear-online-cache",
      scanProgress: "music-id3:scan-progress"
    });
  });

  it("rejects arbitrary channels", () => {
    expect(isIpcChannel("music-id3:scan-directory")).toBe(true);
    expect(isIpcChannel("music-id3:scan-progress")).toBe(true);
    expect(isIpcChannel("music-id3:execute-javascript")).toBe(false);
  });

  it("registers handlers only for approved invoke channels", () => {
    const registered: string[] = [];
    registerIpcHandlers({
      ipcMain: {
        handle(channel) {
          registered.push(channel);
        }
      },
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      cookieStore: {
        set: async () => undefined,
        redacted: async () => "unconfigured"
      }
    });

    expect(registered).toEqual([
      ipcChannels.selectDirectory,
      ipcChannels.scanDirectory,
      ipcChannels.cancelScan,
      ipcChannels.readAudio,
      ipcChannels.writeAudio,
      ipcChannels.readCue,
      ipcChannels.saveCue,
      ipcChannels.previewCue,
      ipcChannels.buildCandidateCue,
      ipcChannels.searchMetadata,
      ipcChannels.getMetadataCandidate,
      ipcChannels.setProviderCookie,
      ipcChannels.testProviderCookie,
      ipcChannels.getProviderCookieStatus,
      ipcChannels.clearOnlineCache
    ]);
    expect(registered).not.toContain(ipcChannels.scanProgress);
  });

  it("returns only redacted Cookie configuration status", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    registerIpcHandlers({
      ipcMain: { handle(channel, listener) { handlers.set(channel, listener); } },
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      cookieStore: { set: async () => undefined, redacted: async () => "configured" }
    });
    await expect(handlers.get(ipcChannels.getProviderCookieStatus)?.({}, "netease")).resolves.toBe("configured");
  });

  it("previews raw CUE and builds a MusicBrainz candidate document", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    registerIpcHandlers({ ipcMain: { handle(channel, listener) { handlers.set(channel, listener); } }, showOpenDialog: async () => ({ canceled: true, filePaths: [] }), cookieStore: { set: async () => undefined, redacted: async () => "unconfigured" } });
    const preview = await handlers.get(ipcChannels.previewCue)?.({}, "D:/Music/disc.cue", 'TITLE "Edited"\nFILE "disc.flac" WAVE\n TRACK 01 AUDIO\n  INDEX 01 00:00:00');
    expect(preview).toMatchObject({ parsed: { title: "Edited" } });
    expect((preview as { parseError?: string }).parseError).toBeUndefined();
    const built = await handlers.get(ipcChannels.buildCandidateCue)?.({}, { audioPath: "D:/Music/disc.flac", candidate: { id: "mb", source: "musicbrainz", title: "Release", artist: "Artist", offsets: [150, 7650], tracks: [{ number: 1, title: "One" }, { number: 2, title: "Two" }], confidence: "high" } });
    expect(built).toMatchObject({ title: "Release", performer: "Artist", files: [{ path: "disc.flac" }], tracks: [{ title: "One" }, { title: "Two" }] });
  });

  it("loads selected candidate details and cover art", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const details = { id: "release", source: "musicbrainz" as const, title: "Release", tracks: [{ number: 1, title: "One" }], offsets: [150], confidence: "high" as const };
    registerIpcHandlers({
      ipcMain: { handle(channel, listener) { handlers.set(channel, listener); } },
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      cookieStore: { set: async () => undefined, redacted: async () => "unconfigured" },
      metadataAdapters: {
        musicbrainz: {
          search: async () => [],
          getDetails: async () => details,
          getCover: async () => ({ mimeType: "image/jpeg", data: "AQID" })
        }
      }
    });

    await expect(handlers.get(ipcChannels.getMetadataCandidate)?.({}, "musicbrainz", "release")).resolves.toEqual({
      ...details,
      cover: { mimeType: "image/jpeg", data: "AQID" }
    });
  });

  it("returns candidate details with a cover-specific warning when cover loading fails", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const details = { id: "release", source: "musicbrainz" as const, title: "Release", date: "2026", confidence: "high" as const };
    registerIpcHandlers({
      ipcMain: { handle(channel, listener) { handlers.set(channel, listener); } },
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      cookieStore: { set: async () => undefined, redacted: async () => "unconfigured" },
      metadataAdapters: { musicbrainz: { search: async () => [], getDetails: async () => details, getCover: async () => { throw new Error("private CDN failure"); } } }
    });

    await expect(handlers.get(ipcChannels.getMetadataCandidate)?.({}, "musicbrainz", "release")).resolves.toEqual({
      ...details,
      warnings: ["Cover art unavailable"]
    });
  });

  it("starts a scan and publishes typed progress only to the invoking renderer", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const root = await createTempDir();
    await writeFile(path.join(root, "notes.txt"), "not audio");
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const progress: unknown[] = [];
    registerIpcHandlers({
      ipcMain: { handle(channel, listener) { handlers.set(channel, listener); } },
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      cookieStore: { set: async () => undefined, redacted: async () => "unconfigured" }
    });

    const started = await handlers.get(ipcChannels.scanDirectory)?.({
      sender: {
        send(channel: string, payload: unknown) {
          expect(channel).toBe(ipcChannels.scanProgress);
          progress.push(payload);
          if ((payload as { phase?: string }).phase === "complete") {
            complete();
          }
        }
      }
    }, root, "renderer-request");
    await completed;

    expect(started).toEqual({ ok: true, requestId: "renderer-request", scanId: expect.any(String) });
    expect(progress).toEqual([
      expect.objectContaining({ phase: "complete", scannedCount: 0, scanId: (started as { scanId: string }).scanId })
    ]);
  });

  it("aborts the matching main-process scan without publishing completion", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    let signal: AbortSignal | undefined;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const progress: unknown[] = [];
    registerIpcHandlers({ ipcMain: { handle(channel, listener) { handlers.set(channel, listener); } }, showOpenDialog: async () => ({ canceled: true, filePaths: [] }), cookieStore: { set: async () => undefined, redacted: async () => "unconfigured" }, scanLibrary: async (_root, _onItem, currentSignal) => { signal = currentSignal; await blocked; return { items: [], errors: [] }; } });
    const started = await handlers.get(ipcChannels.scanDirectory)?.({ sender: { send: (_channel: string, payload: unknown) => progress.push(payload) } }, "D:/Music", "renderer-request") as { scanId: string };
    await handlers.get(ipcChannels.cancelScan)?.({}, "renderer-request");
    expect(signal?.aborted).toBe(true); release(); await Promise.resolve(); await Promise.resolve();
    expect(progress).toEqual([]);
  });

  it("registers scan ownership under the renderer request ID before scanning begins", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    let signal: AbortSignal | undefined;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    registerIpcHandlers({ ipcMain: { handle(channel, listener) { handlers.set(channel, listener); } }, showOpenDialog: async () => ({ canceled: true, filePaths: [] }), cookieStore: { set: async () => undefined, redacted: async () => "unconfigured" }, scanLibrary: async (_root, _onItem, currentSignal) => { signal = currentSignal; await blocked; return { items: [], errors: [] }; } });

    const started = handlers.get(ipcChannels.scanDirectory)?.({ sender: { send: () => undefined } }, "D:/Music", "renderer-request") as { requestId: string };
    await handlers.get(ipcChannels.cancelScan)?.({}, "renderer-request");

    expect(started).toMatchObject({ ok: true, requestId: "renderer-request" });
    expect(signal?.aborted).toBe(true);
    release();
  });

  it("reads and saves CUE files through the concrete allow-listed handlers", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const root = await createTempDir();
    const cuePath = path.join(root, "album.cue");
    const original = 'TITLE "Before"\nFILE "disc.flac" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00';
    const replacement: CueDocument = {
      title: "After",
      remarks: [],
      files: [{ path: "disc.flac", type: "WAVE" }],
      tracks: [{ number: 1, fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }],
      unknownLines: []
    };
    await writeFile(cuePath, original);
    registerIpcHandlers({
      ipcMain: { handle(channel, listener) { handlers.set(channel, listener); } },
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      cookieStore: { set: async () => undefined, redacted: async () => "unconfigured" }
    });

    const read = await handlers.get(ipcChannels.readCue)?.({}, cuePath);
    const saved = await handlers.get(ipcChannels.saveCue)?.({}, {
      path: cuePath,
      document: replacement,
      rawText: "",
      encoding: "utf8"
    });

    expect(read).toMatchObject({ path: cuePath, parsed: { title: "Before" } });
    expect(saved).toEqual({ ok: true, path: cuePath, backupPath: `${cuePath}.bak` });
  });

  it("rejects forged CUE source text received from the renderer", async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const root = await createTempDir();
    const cuePath = path.join(root, "forged.cue");
    const document: CueDocument = {
      title: "Safe",
      remarks: [],
      files: [{ path: "disc.flac" }],
      tracks: [{ number: 1, fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }],
      unknownLines: [],
      sourceText: "THIS IS NOT A CUE",
      sourceFingerprint: JSON.stringify({
        title: "Safe",
        remarks: [],
        files: [{ path: "disc.flac" }],
        tracks: [{ number: 1, fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }],
        unknownLines: []
      })
    };
    registerIpcHandlers({
      ipcMain: { handle(channel, listener) { handlers.set(channel, listener); } },
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      cookieStore: { set: async () => undefined, redacted: async () => "unconfigured" }
    });

    const result = await handlers.get(ipcChannels.saveCue)?.({}, {
      path: cuePath,
      document,
      rawText: document.sourceText,
      encoding: "utf8"
    });

    expect(result).toEqual({ ok: false, error: expect.any(String) });
  });
});
