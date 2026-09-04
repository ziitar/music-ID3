import path from "node:path";
import { supportedAudioExtensions, wholeTrackThresholdMs } from "../../shared/config";

export type WholeTrackStatus = "normal" | "suspected" | "overridden";

export function isSupportedAudioPath(filePath: string): boolean {
  return supportedAudioExtensions.includes(path.extname(filePath).toLowerCase() as (typeof supportedAudioExtensions)[number]);
}

export function isSuspectedWholeTrack(durationMs: number, hasCue: boolean): boolean {
  return !hasCue && durationMs > wholeTrackThresholdMs;
}

export function wholeTrackStatus(durationMs: number, hasCue: boolean, overridden = false): WholeTrackStatus {
  if (overridden) {
    return "overridden";
  }
  return isSuspectedWholeTrack(durationMs, hasCue) ? "suspected" : "normal";
}
