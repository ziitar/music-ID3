import type {
  AudioMetadata,
  BuildCandidateCueInput,
  CookieStatus,
  CueDocument,
  CookieSource,
  CookieTestResult,
  CueDocumentState,
  MetadataCandidate,
  MetadataPatch,
  MetadataSearchContext,
  MetadataSource,
  SaveCueInput,
  SaveCueResult,
  ScanProgress,
  ScanStarted,
  WriteResult
} from "./types";

export const ipcChannels = {
  selectDirectory: "music-id3:select-directory",
  scanDirectory: "music-id3:scan-directory",
  cancelScan: "music-id3:cancel-scan",
  setWholeTrackOverride: "music-id3:set-whole-track-override",
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
} as const;

export type IpcChannel = (typeof ipcChannels)[keyof typeof ipcChannels];

const allowedChannels = new Set<string>(Object.values(ipcChannels));

export function isIpcChannel(channel: string): channel is IpcChannel {
  return allowedChannels.has(channel);
}

export type MusicId3Api = {
  selectDirectory(): Promise<string | undefined>;
  scanDirectory(path: string, requestId: string): Promise<ScanStarted>;
  cancelScan(requestId: string): Promise<void>;
  setWholeTrackOverride(path: string, enabled: boolean): Promise<void>;
  readAudio(path: string): Promise<AudioMetadata>;
  writeAudio(path: string, patch: MetadataPatch): Promise<WriteResult>;
  readCue(path: string, sourceEncoding?: CueDocumentState["encoding"]): Promise<CueDocumentState>;
  saveCue(input: SaveCueInput): Promise<SaveCueResult>;
  previewCue(path: string, rawText: string): Promise<CueDocumentState>;
  buildCandidateCue(input: BuildCandidateCueInput): Promise<CueDocument>;
  searchMetadata(source: MetadataSource, query: string, context?: MetadataSearchContext): Promise<MetadataCandidate[]>;
  getMetadataCandidate(source: MetadataSource, id: string, context?: MetadataSearchContext): Promise<MetadataCandidate>;
  setProviderCookie(source: CookieSource, value: string): Promise<void>;
  testProviderCookie(source: CookieSource): Promise<CookieTestResult>;
  getProviderCookieStatus(source: CookieSource): Promise<CookieStatus>;
  clearOnlineCache(): Promise<void>;
  onScanProgress(listener: (progress: ScanProgress) => void): () => void;
};

declare global {
  interface Window {
    musicId3: MusicId3Api;
  }
}
