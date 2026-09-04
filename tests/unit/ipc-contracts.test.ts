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
      readAudio: "music-id3:read-audio",
      writeAudio: "music-id3:write-audio",
      readCue: "music-id3:read-cue",
      saveCue: "music-id3:save-cue",
      searchMetadata: "music-id3:search-metadata",
      setProviderCookie: "music-id3:set-provider-cookie",
      testProviderCookie: "music-id3:test-provider-cookie",
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
      ipcChannels.readAudio,
      ipcChannels.writeAudio,
      ipcChannels.readCue,
      ipcChannels.saveCue,
      ipcChannels.searchMetadata,
      ipcChannels.setProviderCookie,
      ipcChannels.testProviderCookie
    ]);
    expect(registered).not.toContain(ipcChannels.scanProgress);
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
    }, root);
    await completed;

    expect(started).toEqual({ ok: true, scanId: expect.any(String) });
    expect(progress).toEqual([
      expect.objectContaining({ phase: "complete", scannedCount: 0, scanId: (started as { scanId: string }).scanId })
    ]);
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
