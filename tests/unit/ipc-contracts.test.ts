import { describe, expect, it } from "vitest";
import { registerIpcHandlers } from "../../electron/ipc/register-ipc";
import { ipcChannels, isIpcChannel } from "../../shared/ipc";

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
});
