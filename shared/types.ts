export type MetadataSource = "musicbrainz" | "ctdb" | "netease" | "qq";

export type CookieSource = "netease" | "qq";

export type CoverArt = {
  mimeType: string;
  data: string;
};

export type CommonMetadata = {
  title?: string;
  artist?: string;
  albumArtist?: string;
  album?: string;
  trackNumber?: number;
  trackTotal?: number;
  discNumber?: number;
  discTotal?: number;
  date?: string;
  genre?: string;
  composer?: string;
  comment?: string;
  lyrics?: string;
  copyright?: string;
  cover?: CoverArt;
};

export type AudioMetadata = {
  common: CommonMetadata;
  raw: Record<string, string | string[]>;
  durationMs: number;
  format?: string;
  errors?: string[];
};

export type MetadataPatch = {
  fields: Partial<CommonMetadata>;
  selectedFields: Array<keyof CommonMetadata>;
};

export type CueEncoding = "utf8" | "utf8-bom" | "gb18030" | "gbk" | "big5" | "shift-jis";

export type CueTrack = {
  number: number;
  type?: string;
  fileIndex?: number;
  title?: string;
  performer?: string;
  songwriter?: string;
  pregap?: string;
  postgap?: string;
  indexes: Array<{ number: number; time: string }>;
};

export type CuePreservedLine = {
  text: string;
  scope: "album" | "file" | "track";
  fileIndex?: number;
  trackIndex?: number;
  order: number;
};

export type CueDocument = {
  title?: string;
  performer?: string;
  songwriter?: string;
  remarks: string[];
  files: Array<{ path: string; type?: string }>;
  tracks: CueTrack[];
  unknownLines: string[];
  preservedLines?: CuePreservedLine[];
  sourceText?: string;
  sourceFingerprint?: string;
};

export type CueDocumentState = {
  path: string;
  encoding: CueEncoding;
  rawText: string;
  parsed: CueDocument;
  referencedFiles: string[];
  missingReferencedFiles: string[];
  candidateEncodings?: CueEncoding[];
  parseError?: string;
};

export type SaveCueInput = {
  path: string;
  document: CueDocument;
  rawText: string;
  encoding: CueEncoding;
};

export type LibraryItem =
  | {
      kind: "audio";
      path: string;
      fileName: string;
      extension: string;
      sizeBytes: number;
      durationMs: number;
      metadata: AudioMetadata;
      cover?: CoverArt;
      cuePath?: string;
      wholeTrackStatus: "normal" | "suspected" | "overridden";
    }
  | {
      kind: "cue";
      path: string;
      encoding: CueEncoding;
      rawText: string;
      parsed: CueDocument;
      referencedFiles: string[];
      missingReferencedFiles: string[];
      candidateEncodings?: CueEncoding[];
      parseError?: string;
    };

export type MetadataCandidate = {
  id: string;
  source: MetadataSource;
  title: string;
  artist?: string;
  album?: string;
  date?: string;
  trackCount?: number;
  tracks?: Array<{ number: number; title: string; artist?: string; durationMs?: number }>;
  cover?: CoverArt;
  confidence: "high" | "medium" | "low";
  evidence?: string[];
};

export type ScanStarted = {
  ok: true;
  scanId: string;
};

export type WriteResult =
  | { ok: true; metadata: AudioMetadata }
  | { ok: false; error: string; unsupportedFields?: Array<keyof CommonMetadata> };

export type SaveCueResult =
  | { ok: true; path: string; backupPath?: string }
  | { ok: false; error: string };

export type CookieTestResult =
  | { ok: true; status: "configured" }
  | { ok: false; error: string };

export type ScanProgress = {
  scanId: string;
  item?: LibraryItem;
  scannedCount: number;
  totalCount?: number;
  phase: "scanning" | "complete" | "error";
  error?: string;
};
