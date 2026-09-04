import { describe, expect, it } from "vitest";
import { supportedAudioExtensions, wholeTrackThresholdMs } from "../../shared/config";

describe("app configuration", () => {
  it("declares the supported formats and 15 minute threshold", () => {
    expect(supportedAudioExtensions).toEqual([
      ".mp3",
      ".flac",
      ".m4a",
      ".mp4",
      ".ogg",
      ".opus",
      ".wav",
      ".ape",
      ".wv"
    ]);
    expect(wholeTrackThresholdMs).toBe(15 * 60 * 1000);
  });
});
