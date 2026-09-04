import type {
  AudioMetadata,
  CookieSource,
  CookieTestResult,
  CueDocumentState,
  MetadataCandidate,
  MetadataPatch,
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
  readAudio: "music-id3:read-audio",
  writeAudio: "music-id3:write-audio",
  readCue: "music-id3:read-cue",
  saveCue: "music-id3:save-cue",
  searchMetadata: "music-id3:search-metadata",
  setProviderCookie: "music-id3:set-provider-cookie",
  testProviderCookie: "music-id3:test-provider-cookie",
  scanProgress: "music-id3:scan-progress"
} as const;

export type IpcChannel = (typeof ipcChannels)[keyof typeof ipcChannels];

const allowedChannels = new Set<string>(Object.values(ipcChannels));

export function isIpcChannel(channel: string): channel is IpcChannel {
  return allowedChannels.has(channel);
}

export type MusicId3Api = {
  selectDirectory(): Promise<string | undefined>;
  scanDirectory(path: string): Promise<ScanStarted>;
  readAudio(path: string): Promise<AudioMetadata>;
  writeAudio(path: string, patch: MetadataPatch): Promise<WriteResult>;
  readCue(path: string): Promise<CueDocumentState>;
  saveCue(input: SaveCueInput): Promise<SaveCueResult>;
  searchMetadata(source: MetadataSource, query: string): Promise<MetadataCandidate[]>;
  setProviderCookie(source: CookieSource, value: string): Promise<void>;
  testProviderCookie(source: CookieSource): Promise<CookieTestResult>;
  onScanProgress(listener: (progress: ScanProgress) => void): () => void;
};

declare global {
  interface Window {
    musicId3: MusicId3Api;
  }
}
