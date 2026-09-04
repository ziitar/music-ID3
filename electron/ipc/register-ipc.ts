import type { OpenDialogOptions } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { CookieSource } from "../../shared/types";
import type { CookieStore } from "../services/cookie-store";

type IpcMainLike = {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
};

type RegisterIpcHandlersOptions = {
  ipcMain: IpcMainLike;
  showOpenDialog(options: OpenDialogOptions): Promise<{ canceled: boolean; filePaths: string[] }>;
  cookieStore: Pick<CookieStore, "set" | "redacted">;
};

function asString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string`);
  }
  return value;
}

function asCookieSource(value: unknown): CookieSource {
  if (value === "netease" || value === "qq") {
    return value;
  }
  throw new TypeError("Cookie source must be netease or qq");
}

function unavailable(operation: string): never {
  throw new Error(`${operation} is not available yet`);
}

export function registerIpcHandlers({ ipcMain, showOpenDialog, cookieStore }: RegisterIpcHandlersOptions): void {
  ipcMain.handle(ipcChannels.selectDirectory, async () => {
    const result = await showOpenDialog({ properties: ["openDirectory"] });
    return result.canceled ? undefined : result.filePaths[0];
  });

  ipcMain.handle(ipcChannels.scanDirectory, (_event, directoryPath) => {
    asString(directoryPath, "path");
    return unavailable("Directory scanning");
  });

  ipcMain.handle(ipcChannels.readAudio, (_event, audioPath) => {
    asString(audioPath, "path");
    return unavailable("Audio metadata reads");
  });

  ipcMain.handle(ipcChannels.writeAudio, (_event, audioPath) => {
    asString(audioPath, "path");
    return unavailable("Audio metadata writes");
  });

  ipcMain.handle(ipcChannels.readCue, (_event, cuePath) => {
    asString(cuePath, "path");
    return unavailable("CUE reads");
  });

  ipcMain.handle(ipcChannels.saveCue, () => unavailable("CUE saves"));

  ipcMain.handle(ipcChannels.searchMetadata, (_event, source, query) => {
    asString(source, "source");
    asString(query, "query");
    return unavailable("Metadata search");
  });

  ipcMain.handle(ipcChannels.setProviderCookie, async (_event, source, value) => {
    await cookieStore.set(asCookieSource(source), asString(value, "value"));
  });

  ipcMain.handle(ipcChannels.testProviderCookie, async (_event, source) => {
    const cookieSource = asCookieSource(source);
    return (await cookieStore.redacted(cookieSource)) === "configured"
      ? { ok: false, error: "Provider connectivity checks are not available yet" }
      : { ok: false, error: "No Cookie configured" };
  });
}
