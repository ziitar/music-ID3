import { randomUUID } from "node:crypto";
import type { OpenDialogOptions } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { BuildCandidateCueInput, CookieSource, CueEncoding, MetadataCandidate, MetadataPatch, SaveCueInput, ScanProgress } from "../../shared/types";
import type { MetadataSource } from "../../shared/types";
import type { CookieStore } from "../services/cookie-store";
import type { MetadataAdapter } from "../services/metadata/adapter";
import { scanDirectory } from "../services/library-scanner";
import { readAudioMetadata, writeAudioMetadata } from "../services/tag-service";
import { parseCue, readCue, saveCue } from "../services/cue-service";
import { buildCandidateCue } from "../services/cue-candidate";

type IpcMainLike = {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
};

type RegisterIpcHandlersOptions = {
  ipcMain: IpcMainLike;
  showOpenDialog(options: OpenDialogOptions): Promise<{ canceled: boolean; filePaths: string[] }>;
  cookieStore: Pick<CookieStore, "set" | "redacted">;
  metadataAdapters?: Partial<Record<MetadataSource, MetadataAdapter>>;
  clearOnlineCache?: () => void;
  scanLibrary?: typeof scanDirectory;
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

function asMetadataSource(value: unknown): MetadataSource {
  if (value === "musicbrainz" || value === "ctdb" || value === "netease" || value === "qq") {
    return value;
  }
  throw new TypeError("Metadata source must be musicbrainz, ctdb, netease, or qq");
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

export function registerIpcHandlers({
  ipcMain,
  showOpenDialog,
  cookieStore,
  metadataAdapters = {},
  clearOnlineCache = () => undefined,
  scanLibrary = scanDirectory
}: RegisterIpcHandlersOptions): void {
  const scans = new Map<string, AbortController>();
  ipcMain.handle(ipcChannels.selectDirectory, async () => {
    const result = await showOpenDialog({ properties: ["openDirectory"] });
    return result.canceled ? undefined : result.filePaths[0];
  });

  ipcMain.handle(ipcChannels.scanDirectory, (event, directoryPath, rendererRequestId) => {
    const root = asString(directoryPath, "path");
    const requestId = asString(rendererRequestId, "requestId");
    const scanId = randomUUID();
    let scannedCount = 0;
    const controller = new AbortController();
    scans.get(requestId)?.abort();
    scans.set(requestId, controller);
    void scanLibrary(root, (item) => {
      if (controller.signal.aborted) return;
      scannedCount += 1;
      publishScanProgress(event, { requestId, scanId, item, scannedCount, phase: "scanning" });
    }, controller.signal).then((summary) => {
      if (controller.signal.aborted) return;
      for (const scanError of summary.errors) {
        publishScanProgress(event, { requestId, scanId, scannedCount, phase: "error", error: `${scanError.path}: ${scanError.error}` });
      }
      publishScanProgress(event, { requestId, scanId, scannedCount, totalCount: summary.items.length, phase: "complete" });
    }).catch((error) => {
      if (controller.signal.aborted) return;
      publishScanProgress(event, {
        requestId,
        scanId,
        scannedCount,
        phase: "error",
        error: error instanceof Error ? error.message : String(error)
      });
    }).finally(() => { if (scans.get(requestId) === controller) scans.delete(requestId); });
    return { ok: true, requestId, scanId };
  });

  ipcMain.handle(ipcChannels.cancelScan, (_event, requestId) => {
    scans.get(asString(requestId, "requestId"))?.abort();
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

  ipcMain.handle(ipcChannels.previewCue, (_event, cuePath, rawText) => parseCue(asString(rawText, "rawText"), asString(cuePath, "path")));

  ipcMain.handle(ipcChannels.buildCandidateCue, (_event, value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Candidate CUE input must be an object");
    const input = value as Partial<BuildCandidateCueInput>;
    const candidate = input.candidate as MetadataCandidate | undefined;
    if (!candidate || candidate.source !== "musicbrainz" || !candidate.tracks || !candidate.offsets) throw new TypeError("MusicBrainz candidate requires tracks and offsets");
    return buildCandidateCue({ audioPath: asString(input.audioPath, "audioPath"), album: candidate.album ?? candidate.title, performer: candidate.artist, date: candidate.date, offsets: candidate.offsets, tracks: candidate.tracks.map((track) => ({ title: track.title, performer: track.artist })), fileType: "WAVE" });
  });

  ipcMain.handle(ipcChannels.searchMetadata, (_event, source, query) => {
    const metadataSource = asMetadataSource(source);
    const adapter = metadataAdapters[metadataSource];
    if (!adapter) throw new Error(`Metadata source ${metadataSource} is not configured`);
    return adapter.search(asString(query, "query"));
  });

  ipcMain.handle(ipcChannels.getMetadataCandidate, async (_event, source, id) => {
    const metadataSource = asMetadataSource(source);
    const adapter = metadataAdapters[metadataSource];
    if (!adapter) throw new Error(`Metadata source ${metadataSource} is not configured`);
    const candidate = await adapter.getDetails(asString(id, "id"));
    try {
      const cover = await adapter.getCover(candidate);
      return { ...candidate, ...(cover ? { cover } : {}) };
    } catch {
      return { ...candidate, warnings: [...(candidate.warnings ?? []), "Cover art unavailable"] };
    }
  });

  ipcMain.handle(ipcChannels.setProviderCookie, async (_event, source, value) => {
    await cookieStore.set(asCookieSource(source), asString(value, "value"));
  });

  ipcMain.handle(ipcChannels.testProviderCookie, async (_event, source) => {
    const cookieSource = asCookieSource(source);
    if ((await cookieStore.redacted(cookieSource)) !== "configured") {
      return { ok: false, error: "No Cookie configured" };
    }
    try {
      const adapter = metadataAdapters[cookieSource];
      if (!adapter) return { ok: false, error: "Provider is not configured" };
      if (adapter.testConnection) await adapter.testConnection();
      else await adapter.search("test");
      return { ok: true, status: "configured" };
    } catch {
      return { ok: false, error: "Provider connectivity check failed" };
    }
  });

  ipcMain.handle(ipcChannels.getProviderCookieStatus, (_event, source) => cookieStore.redacted(asCookieSource(source)));

  ipcMain.handle(ipcChannels.clearOnlineCache, async () => {
    clearOnlineCache();
  });
}
