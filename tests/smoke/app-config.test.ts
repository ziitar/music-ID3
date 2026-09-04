import { describe, expect, it } from "vitest";
import { supportedAudioExtensions, wholeTrackThresholdMs } from "../../shared/config";

describe("app configuration", () => {
  it("declares the supported formats and 15 minute threshold", () => {
    expect(supportedAudioExtensions).toContain(".flac");
    expect(supportedAudioExtensions).toContain(".mp3");
    expect(wholeTrackThresholdMs).toBe(15 * 60 * 1000);
  });
});
