import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerIpcHandlers } from "../../electron/ipc/register-ipc";
import { ipcChannels, isIpcChannel } from "../../shared/ipc";

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
});
