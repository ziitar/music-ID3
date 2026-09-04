import { randomUUID } from "node:crypto";
import type { OpenDialogOptions } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { CookieSource, CueEncoding, MetadataPatch, SaveCueInput, ScanProgress } from "../../shared/types";
import type { CookieStore } from "../services/cookie-store";
import { scanDirectory } from "../services/library-scanner";
import { readAudioMetadata, writeAudioMetadata } from "../services/tag-service";
import { readCue, saveCue } from "../services/cue-service";

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

function asMetadataPatch(value: unknown): MetadataPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Metadata patch must be an object");
  }
  const patch = value as Partial<MetadataPatch>;
  if (!patch.fields || typeof patch.fields !== "object" || Array.isArray(patch.fields) || !Array.isArray(patch.selectedFields)) {
    throw new TypeError("Metadata patch must include fields and selectedFields");
  }
  return patch as MetadataPatch;
}

function asCueEncoding(value: unknown): CueEncoding {
  if (["utf8", "utf8-bom", "gb18030", "gbk", "big5", "shift-jis"].includes(value as string)) {
    return value as CueEncoding;
  }
  throw new TypeError("Unsupported CUE encoding");
}

function asSaveCueInput(value: unknown): SaveCueInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("CUE save input must be an object");
  }
  const input = value as Partial<SaveCueInput>;
  if (!input.document || typeof input.document !== "object" || Array.isArray(input.document)) {
    throw new TypeError("CUE save input must include a document");
  }
  return {
    path: asString(input.path, "path"),
    document: input.document as SaveCueInput["document"],
    rawText: asString(input.rawText, "rawText"),
    encoding: asCueEncoding(input.encoding)
  };
}

function publishScanProgress(event: unknown, progress: ScanProgress): void {
  const sender = (event as { sender?: { send(channel: string, payload: ScanProgress): void } } | undefined)?.sender;
  sender?.send(ipcChannels.scanProgress, progress);
}

function unavailable(operation: string): never {
  throw new Error(`${operation} is not available yet`);
}

export function registerIpcHandlers({ ipcMain, showOpenDialog, cookieStore }: RegisterIpcHandlersOptions): void {
  ipcMain.handle(ipcChannels.selectDirectory, async () => {
    const result = await showOpenDialog({ properties: ["openDirectory"] });
    return result.canceled ? undefined : result.filePaths[0];
  });

  ipcMain.handle(ipcChannels.scanDirectory, (event, directoryPath) => {
    const root = asString(directoryPath, "path");
    const scanId = randomUUID();
    let scannedCount = 0;
    void scanDirectory(root, (item) => {
      scannedCount += 1;
      publishScanProgress(event, { scanId, item, scannedCount, phase: "scanning" });
    }).then((summary) => {
      for (const scanError of summary.errors) {
        publishScanProgress(event, { scanId, scannedCount, phase: "error", error: `${scanError.path}: ${scanError.error}` });
      }
      publishScanProgress(event, { scanId, scannedCount, totalCount: summary.items.length, phase: "complete" });
    }).catch((error) => {
      publishScanProgress(event, {
        scanId,
        scannedCount,
        phase: "error",
        error: error instanceof Error ? error.message : String(error)
      });
    });
    return { ok: true, scanId };
  });

  ipcMain.handle(ipcChannels.readAudio, (_event, audioPath) => {
    return readAudioMetadata(asString(audioPath, "path"));
  });

  ipcMain.handle(ipcChannels.writeAudio, (_event, audioPath, patch) => {
    return writeAudioMetadata(asString(audioPath, "path"), asMetadataPatch(patch));
  });

  ipcMain.handle(ipcChannels.readCue, (_event, cuePath) => {
    return readCue(asString(cuePath, "path"));
  });

  ipcMain.handle(ipcChannels.saveCue, (_event, input) => saveCue(asSaveCueInput(input)));

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
