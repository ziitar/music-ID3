import path from "node:path";
import type { CueDocument, CueProvenance } from "../../shared/types";
import { framesToCueTime } from "../../shared/cue-time";

export type CandidateCueInput = {
  audioPath: string;
  album: string;
  performer?: string;
  date?: string;
  offsets: number[];
  tracks: Array<{ title: string; performer?: string }>;
  fileType?: string;
  provenance?: CueProvenance;
};

export function cueFileTypeForAudioPath(audioPath: string): "MP3" | "WAVE" {
  const extension = path.extname(audioPath).toLocaleLowerCase("en-US");
  if (extension === ".mp3") return "MP3";
  if ([".wav", ".flac", ".ape", ".wv"].includes(extension)) return "WAVE";
  throw new Error(`Unsupported audio container ${extension || "(none)"} for a standard CUE FILE type`);
}

export function buildCandidateCue(input: CandidateCueInput): CueDocument {
  if (input.tracks.length === 0 || input.offsets.length !== input.tracks.length) {
    throw new Error("Candidate CUE requires one offset per track");
  }
  for (let index = 0; index < input.offsets.length; index += 1) {
    const offset = input.offsets[index];
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error("MusicBrainz offsets must be non-negative integers");
    }
    if (index > 0 && offset <= input.offsets[index - 1]) {
      throw new Error("MusicBrainz offsets must be strictly increasing");
    }
  }

  const firstOffset = input.offsets[0];
  return {
    title: input.album,
    performer: input.performer,
    remarks: input.date ? [`DATE ${input.date}`] : [],
    files: [{ path: path.basename(input.audioPath), type: input.fileType ?? cueFileTypeForAudioPath(input.audioPath) }],
    tracks: input.tracks.map((track, index) => ({
      number: index + 1,
      type: "AUDIO",
      fileIndex: 0,
      title: track.title,
      performer: track.performer,
      indexes: [{ number: 1, time: framesToCueTime(input.offsets[index] - firstOffset) }]
    })),
    unknownLines: [],
    ...(input.provenance ? { provenance: { ...input.provenance, evidence: [...input.provenance.evidence] } } : {})
  };
}
