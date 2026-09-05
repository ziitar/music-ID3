import { randomUUID } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { OpenDialogOptions } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type {
  BuildCandidateCueInput,
  CommonMetadata,
  CookieSource,
  CueDocument,
  CueEncoding,
  LibraryItem,
  MetadataCandidate,
  MetadataPatch,
  MetadataSearchContext,
  MetadataSource,
  PrepareCueSaveInput,
  SaveCueInput,
  ScanProgress
} from "../../shared/types";
import type { CookieStore } from "../services/cookie-store";
import { isSupportedAudioPath } from "../services/audio-format";
import { buildCandidateCue } from "../services/cue-candidate";
import { cueDocumentForSave, parseCue, prepareCueSave, readCue, saveCue } from "../services/cue-service";
import { scanDirectory } from "../services/library-scanner";
import { scoreCandidate, type MetadataAdapter } from "../services/metadata/adapter";
import type { CtdbAdapter } from "../services/metadata/ctdb-adapter";
import { readAudioMetadata, writeAudioMetadata } from "../services/tag-service";

type IpcMainLike = {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
};

type SenderLike = {
  id: number;
  send?(channel: string, payload: ScanProgress): void;
  once?(event: "destroyed", listener: () => void): void;
};

type MetadataAdapterWithValidation = MetadataAdapter & Partial<Pick<CtdbAdapter, "validate">>;

type RegisterIpcHandlersOptions = {
  ipcMain: IpcMainLike;
  showOpenDialog(options: OpenDialogOptions): Promise<{ canceled: boolean; filePaths: string[] }>;
  cookieStore: Pick<CookieStore, "set" | "redacted">;
  metadataAdapters?: Partial<Record<MetadataSource, MetadataAdapterWithValidation>>;
  clearOnlineCache?: () => void;
  scanLibrary?: typeof scanDirectory;
  readAudio?: typeof readAudioMetadata;
  writeAudio?: typeof writeAudioMetadata;
  readCueFile?: typeof readCue;
  prepareCueSaveFile?: typeof prepareCueSave;
  saveCueFile?: typeof saveCue;
};

type RendererAuthorization = {
  canonicalRoot: string;
  scanFacts: Map<string, Extract<LibraryItem, { kind: "audio" }>["wholeTrackStatus"]>;
  audioOverrides: Set<string>;
};

const metadataFields = new Set<keyof CommonMetadata>([
  "title", "artist", "albumArtist", "album", "trackNumber", "trackTotal", "discNumber", "discTotal",
  "date", "genre", "composer", "comment", "lyrics", "copyright", "cover"
]);

function asString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function asNonEmptyString(value: unknown, name: string): string {
  const text = asString(value, name);
  if (!text.trim()) throw new TypeError(`${name} must not be empty`);
  return text;
}

function asCookieSource(value: unknown): CookieSource {
  if (value === "netease" || value === "qq") return value;
  throw new TypeError("Cookie source must be netease or qq");
}

function asMetadataSource(value: unknown): MetadataSource {
  if (value === "musicbrainz" || value === "ctdb" || value === "netease" || value === "qq") return value;
  throw new TypeError("Metadata source must be musicbrainz, ctdb, netease, or qq");
}

function asMetadataPatch(value: unknown): MetadataPatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Metadata patch must be an object");
  const patch = value as Partial<MetadataPatch>;
  if (!patch.fields || typeof patch.fields !== "object" || Array.isArray(patch.fields) || !Array.isArray(patch.selectedFields)) {
    throw new TypeError("Metadata patch must include fields and selectedFields");
  }
  if (patch.selectedFields.some((field) => !metadataFields.has(field)) || Object.keys(patch.fields).some((field) => !metadataFields.has(field as keyof CommonMetadata))) {
    throw new TypeError("Metadata patch contains an unsupported field");
  }
  return { fields: { ...patch.fields }, selectedFields: [...patch.selectedFields] } as MetadataPatch;
}

function asCueEncoding(value: unknown): CueEncoding {
  if (["utf8", "utf8-bom", "gb18030", "gbk", "big5", "shift-jis"].includes(value as string)) return value as CueEncoding;
  throw new TypeError("Unsupported CUE encoding");
}

function asPrepareCueSaveInput(value: unknown): PrepareCueSaveInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("CUE save input must be an object");
  const input = value as Partial<PrepareCueSaveInput>;
  if (!input.document || typeof input.document !== "object" || Array.isArray(input.document)) throw new TypeError("CUE save input must include a document");
  return {
    path: asString(input.path, "path"),
    document: input.document as SaveCueInput["document"],
    rawText: asString(input.rawText, "rawText"),
    encoding: asCueEncoding(input.encoding)
  };
}

function asSaveCueInput(value: unknown): SaveCueInput {
  const input = asPrepareCueSaveInput(value);
  const confirmationToken = asNonEmptyString((value as Partial<SaveCueInput>).confirmationToken, "confirmationToken");
  if (confirmationToken.length > 200) throw new TypeError("confirmationToken is too long");
  return { ...input, confirmationToken };
}

function asSearchContext(value: unknown): MetadataSearchContext | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Metadata search context must be an object");
  const input = value as Record<string, unknown>;
  const allowed = new Set(["title", "artist", "trackCount", "durationMs", "trackDurationsMs", "discId", "toc"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new TypeError("Metadata search context contains an unsupported field");
  const output: MetadataSearchContext = {};
  for (const key of ["title", "artist", "discId", "toc"] as const) {
    if (input[key] !== undefined) output[key] = asString(input[key], key);
  }
  for (const key of ["trackCount", "durationMs"] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== "number" || !Number.isFinite(input[key]) || input[key] < 0) throw new TypeError(`${key} must be a non-negative number`);
      output[key] = input[key];
    }
  }
  if (input.trackDurationsMs !== undefined) {
    if (!Array.isArray(input.trackDurationsMs) || input.trackDurationsMs.length > 200 || input.trackDurationsMs.some((entry) => typeof entry !== "number" || !Number.isFinite(entry) || entry < 0)) {
      throw new TypeError("trackDurationsMs must be a bounded array of non-negative numbers");
    }
    output.trackDurationsMs = [...input.trackDurationsMs] as number[];
  }
  return output;
}

function senderFor(event: unknown): SenderLike {
  const sender = (event as { sender?: Partial<SenderLike> } | undefined)?.sender;
  if (!sender || !Number.isInteger(sender.id)) throw new Error("Renderer identity is unavailable");
  return sender as SenderLike;
}

function pathKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function validatePathCapability(filePath: string, capability: "audio" | "cue" | "directory"): void {
  if (capability === "audio" && !isSupportedAudioPath(filePath)) throw new Error("Path must use a supported audio extension");
  if (capability === "cue" && path.extname(filePath).toLocaleLowerCase("en-US") !== ".cue") throw new Error("CUE paths must use the .cue extension");
}

function publishScanProgress(event: unknown, progress: ScanProgress): void {
  senderFor(event).send?.(ipcChannels.scanProgress, progress);
}

function mergeEvidence(...groups: Array<string[] | undefined>): string[] {
  return [...new Set(groups.flatMap((group) => group ?? []))];
}

export function registerIpcHandlers({
  ipcMain,
  showOpenDialog,
  cookieStore,
  metadataAdapters = {},
  clearOnlineCache = () => undefined,
  scanLibrary = scanDirectory,
  readAudio = readAudioMetadata,
  writeAudio = writeAudioMetadata,
  readCueFile = readCue,
  prepareCueSaveFile = prepareCueSave,
  saveCueFile = saveCue
}: RegisterIpcHandlersOptions): void {
  const authorizations = new Map<number, RendererAuthorization>();
  const cleanupRegistered = new Set<number>();
  const scans = new Map<string, AbortController>();

  const scanKey = (senderId: number, requestId: string) => `${senderId}\0${requestId}`;
  const clearSender = (senderId: number): void => {
    authorizations.delete(senderId);
    for (const [key, controller] of scans) {
      if (key.startsWith(`${senderId}\0`)) {
        controller.abort();
        scans.delete(key);
      }
    }
  };
  const authorizationFor = (event: unknown): { sender: SenderLike; authorization: RendererAuthorization } => {
    const sender = senderFor(event);
    const authorization = authorizations.get(sender.id);
    if (!authorization) throw new Error("Select a directory before accessing library paths");
    return { sender, authorization };
  };
  const resolveAuthorizedPath = async (
    event: unknown,
    requestedPath: unknown,
    capability: "audio" | "cue" | "directory",
    allowMissing = false
  ): Promise<{ sender: SenderLike; authorization: RendererAuthorization; canonicalPath: string }> => {
    const { sender, authorization } = authorizationFor(event);
    const provided = path.resolve(asNonEmptyString(requestedPath, "path"));
    validatePathCapability(provided, capability);
    let canonicalPath: string;
    let targetExists = true;
    if (allowMissing) {
      try {
        canonicalPath = await realpath(provided);
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
        try {
          await lstat(provided);
          throw new Error("Generated CUE path cannot be an unresolved symbolic link");
        } catch (entryError) {
          if (!isMissingPathError(entryError)) throw entryError;
        }
        const parent = await realpath(path.dirname(provided));
        if (!(await stat(parent)).isDirectory()) throw new Error("Generated CUE parent must be a directory");
        canonicalPath = path.join(parent, path.basename(provided));
        targetExists = false;
      }
    } else {
      canonicalPath = await realpath(provided);
    }
    if (!isContained(authorization.canonicalRoot, canonicalPath)) throw new Error("Path is outside the selected directory");
    if (targetExists) validatePathCapability(canonicalPath, capability);
    if (capability === "directory" && !(await stat(canonicalPath)).isDirectory()) throw new Error("Scan path must be a directory");
    return { sender, authorization, canonicalPath };
  };
  const resolveCueReferencePath = async (authorization: RendererAuthorization, referencedPath: string): Promise<string> => {
    let existingAncestor = referencedPath;
    const missingSegments: string[] = [];
    let canonicalPath: string;
    while (true) {
      try {
        canonicalPath = path.join(await realpath(existingAncestor), ...missingSegments);
        break;
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
        try {
          await lstat(existingAncestor);
          throw new Error("CUE reference cannot use an unresolved symbolic link");
        } catch (entryError) {
          if (!isMissingPathError(entryError)) throw entryError;
        }
        const parent = path.dirname(existingAncestor);
        if (parent === existingAncestor) throw error;
        missingSegments.unshift(path.basename(existingAncestor));
        existingAncestor = parent;
      }
    }
    if (!isContained(authorization.canonicalRoot, canonicalPath)) throw new Error("CUE reference is outside the selected directory");
    return canonicalPath;
  };
  const validateCueReferences = async (event: unknown, cuePath: string, document: CueDocument): Promise<void> => {
    const { authorization } = authorizationFor(event);
    for (const file of document.files) {
      const usesWindowsNamespace = /^[\\/]{2}[?.][\\/]/.test(file.path);
      const usesUncPath = /^[\\/]{2}/.test(file.path);
      const rootUsesUncPath = /^[\\/]{2}/.test(authorization.canonicalRoot);
      if (usesWindowsNamespace) throw new Error("CUE references cannot use Windows device paths");
      if (usesUncPath && !rootUsesUncPath) throw new Error("UNC CUE reference is outside the selected directory");
      const portableReference = process.platform === "win32" ? file.path : file.path.replace(/\\/g, path.sep);
      const referencedPath = path.resolve(path.dirname(cuePath), portableReference);
      if (file.type?.trim().toLocaleUpperCase("en-US") === "MP3" && path.extname(referencedPath).toLocaleLowerCase("en-US") !== ".mp3") {
        throw new Error("CUE FILE type MP3 requires an .mp3 reference");
      }
      const canonicalReference = await resolveCueReferencePath(authorization, referencedPath);
      if (file.type?.trim().toLocaleUpperCase("en-US") === "MP3" && path.extname(canonicalReference).toLocaleLowerCase("en-US") !== ".mp3") {
        throw new Error("CUE FILE type MP3 requires the canonical target to use an .mp3 extension");
      }
    }
  };
  const rankedCandidates = (candidates: MetadataCandidate[], context?: MetadataSearchContext): MetadataCandidate[] => {
    if (!context) return candidates;
    return candidates.map((candidate, order) => {
      const match = scoreCandidate(context, candidate);
      return { candidate: { ...candidate, confidence: match.confidence, evidence: mergeEvidence(candidate.evidence, match.evidence) }, score: match.score, order };
    }).sort((left, right) => right.score - left.score || left.order - right.order).map((entry) => entry.candidate);
  };

  ipcMain.handle(ipcChannels.selectDirectory, async (event) => {
    const sender = senderFor(event);
    const result = await showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled || !result.filePaths[0]) return undefined;
    const canonicalRoot = await realpath(result.filePaths[0]);
    if (!(await stat(canonicalRoot)).isDirectory()) throw new Error("Selected path is not a directory");
    clearSender(sender.id);
    authorizations.set(sender.id, { canonicalRoot, scanFacts: new Map(), audioOverrides: new Set() });
    if (!cleanupRegistered.has(sender.id) && sender.once) {
      cleanupRegistered.add(sender.id);
      sender.once("destroyed", () => { clearSender(sender.id); cleanupRegistered.delete(sender.id); });
    }
    return result.filePaths[0];
  });

  ipcMain.handle(ipcChannels.scanDirectory, async (event, directoryPath, rendererRequestId) => {
    const { sender, authorization, canonicalPath: root } = await resolveAuthorizedPath(event, directoryPath, "directory");
    const requestId = asNonEmptyString(rendererRequestId, "requestId");
    const scanId = randomUUID();
    let scannedCount = 0;
    const controller = new AbortController();
    const key = scanKey(sender.id, requestId);
    scans.get(key)?.abort();
    scans.set(key, controller);
    authorization.scanFacts.clear();
    authorization.audioOverrides.clear();
    void scanLibrary(root, (item) => {
      if (controller.signal.aborted || authorizations.get(sender.id) !== authorization) return;
      if (item.kind === "audio" && isContained(authorization.canonicalRoot, path.resolve(item.path))) authorization.scanFacts.set(pathKey(item.path), item.wholeTrackStatus);
      scannedCount += 1;
      publishScanProgress(event, { requestId, scanId, item, scannedCount, phase: "scanning" });
    }, controller.signal).then((summary) => {
      if (controller.signal.aborted || authorizations.get(sender.id) !== authorization) return;
      for (const scanError of summary.errors) publishScanProgress(event, { requestId, scanId, scannedCount, phase: "error", error: `${scanError.path}: ${scanError.error}` });
      publishScanProgress(event, { requestId, scanId, scannedCount, totalCount: summary.items.length, phase: "complete" });
    }).catch((error) => {
      if (controller.signal.aborted || authorizations.get(sender.id) !== authorization) return;
      publishScanProgress(event, { requestId, scanId, scannedCount, phase: "error", error: error instanceof Error ? error.message : String(error) });
    }).finally(() => { if (scans.get(key) === controller) scans.delete(key); });
    return { ok: true as const, requestId, scanId };
  });

  ipcMain.handle(ipcChannels.cancelScan, (event, requestId) => {
    const sender = senderFor(event);
    scans.get(scanKey(sender.id, asNonEmptyString(requestId, "requestId")))?.abort();
  });

  ipcMain.handle(ipcChannels.setWholeTrackOverride, async (event, audioPath, enabled) => {
    if (typeof enabled !== "boolean") throw new TypeError("Override state must be boolean");
    const { authorization, canonicalPath } = await resolveAuthorizedPath(event, audioPath, "audio");
    const key = pathKey(canonicalPath);
    if (authorization.scanFacts.get(key) !== "suspected") throw new Error("Only a scanned suspected whole track can receive a normal-audio override");
    if (enabled) authorization.audioOverrides.add(key);
    else authorization.audioOverrides.delete(key);
  });

  ipcMain.handle(ipcChannels.readAudio, async (event, audioPath) => {
    const { canonicalPath } = await resolveAuthorizedPath(event, audioPath, "audio");
    return readAudio(canonicalPath);
  });

  ipcMain.handle(ipcChannels.writeAudio, async (event, audioPath, patch) => {
    const { authorization, canonicalPath } = await resolveAuthorizedPath(event, audioPath, "audio");
    const key = pathKey(canonicalPath);
    const fact = authorization.scanFacts.get(key);
    if (!fact) throw new Error("Audio path was not established by the current scan");
    if (fact === "suspected" && !authorization.audioOverrides.has(key)) throw new Error("A main-process normal-audio override is required for this suspected whole track");
    return writeAudio(canonicalPath, asMetadataPatch(patch));
  });

  ipcMain.handle(ipcChannels.readCue, async (event, cuePath, sourceEncoding) => {
    const { canonicalPath } = await resolveAuthorizedPath(event, cuePath, "cue");
    return readCueFile(canonicalPath, sourceEncoding === undefined ? undefined : asCueEncoding(sourceEncoding));
  });

  ipcMain.handle(ipcChannels.prepareCueSave, async (event, value) => {
    const input = asPrepareCueSaveInput(value);
    const { sender, canonicalPath } = await resolveAuthorizedPath(event, input.path, "cue", true);
    await validateCueReferences(event, canonicalPath, cueDocumentForSave({ ...input, path: canonicalPath }));
    return prepareCueSaveFile({ ...input, path: canonicalPath }, String(sender.id));
  });

  ipcMain.handle(ipcChannels.saveCue, async (event, value) => {
    const input = asSaveCueInput(value);
    const { sender, canonicalPath } = await resolveAuthorizedPath(event, input.path, "cue", true);
    await validateCueReferences(event, canonicalPath, cueDocumentForSave({ ...input, path: canonicalPath }));
    return saveCueFile({ ...input, path: canonicalPath }, String(sender.id));
  });

  ipcMain.handle(ipcChannels.previewCue, async (event, cuePath, rawText) => {
    const { canonicalPath } = await resolveAuthorizedPath(event, cuePath, "cue", true);
    return parseCue(asString(rawText, "rawText"), canonicalPath);
  });

  ipcMain.handle(ipcChannels.buildCandidateCue, async (event, value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Candidate CUE input must be an object");
    const input = value as Partial<BuildCandidateCueInput>;
    const candidate = input.candidate as MetadataCandidate | undefined;
    if (!candidate || candidate.source !== "musicbrainz" || !candidate.tracks || !candidate.offsets) throw new TypeError("MusicBrainz candidate requires tracks and offsets");
    const { canonicalPath: audioPath } = await resolveAuthorizedPath(event, input.audioPath, "audio");
    return buildCandidateCue({
      audioPath,
      album: candidate.album ?? candidate.title,
      performer: candidate.artist,
      date: candidate.date,
      offsets: candidate.offsets,
      tracks: candidate.tracks.map((track) => ({ title: track.title, performer: track.artist })),
      provenance: {
        source: "musicbrainz",
        releaseId: candidate.releaseId ?? candidate.id.split("#medium=", 1)[0],
        ...(candidate.discId ? { discId: candidate.discId } : {}),
        evidence: [...(candidate.evidence ?? [])],
        confidence: candidate.confidence,
        inferred: candidate.confidence !== "high"
      }
    });
  });

  ipcMain.handle(ipcChannels.searchMetadata, async (_event, source, query, contextValue) => {
    const metadataSource = asMetadataSource(source);
    const adapter = metadataAdapters[metadataSource];
    if (!adapter) throw new Error(`Metadata source ${metadataSource} is not configured`);
    return rankedCandidates(await adapter.search(asString(query, "query")), asSearchContext(contextValue));
  });

  ipcMain.handle(ipcChannels.getMetadataCandidate, async (_event, source, id, contextValue) => {
    const metadataSource = asMetadataSource(source);
    const adapter = metadataAdapters[metadataSource];
    if (!adapter) throw new Error(`Metadata source ${metadataSource} is not configured`);
    const context = asSearchContext(contextValue);
    let candidate = await adapter.getDetails(asString(id, "id"));
    if (candidate.source === "musicbrainz" && candidate.toc) {
      const ctdb = metadataAdapters.ctdb;
      if (ctdb?.validate) {
        try {
          const validation = await ctdb.validate(candidate.toc);
          candidate = {
            ...candidate,
            ctdb: { status: validation.status, ...(validation.status === "match" && validation.confidence !== undefined ? { confidence: validation.confidence } : {}) },
            evidence: mergeEvidence(candidate.evidence, validation.evidence),
            ...(validation.status === "unavailable" ? { warnings: mergeEvidence(candidate.warnings, ["CTDB validation unavailable"]) } : {})
          };
        } catch {
          candidate = { ...candidate, warnings: mergeEvidence(candidate.warnings, ["CTDB validation unavailable"]) };
        }
      }
    }
    candidate = rankedCandidates([candidate], context)[0];
    try {
      const cover = await adapter.getCover(candidate);
      return { ...candidate, ...(cover ? { cover } : {}) };
    } catch {
      return { ...candidate, warnings: mergeEvidence(candidate.warnings, ["Cover art unavailable"]) };
    }
  });

  ipcMain.handle(ipcChannels.setProviderCookie, async (_event, source, value) => cookieStore.set(asCookieSource(source), asString(value, "value")));
  ipcMain.handle(ipcChannels.testProviderCookie, async (_event, source) => {
    const cookieSource = asCookieSource(source);
    if ((await cookieStore.redacted(cookieSource)) !== "configured") return { ok: false, error: "No Cookie configured" };
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
  ipcMain.handle(ipcChannels.clearOnlineCache, async () => clearOnlineCache());
}
