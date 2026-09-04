import { readFileSync } from "node:fs";
import path from "node:path";
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

  it("declares the minimum Node runtime required by the locked toolchain", () => {
    const manifest = JSON.parse(readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")) as { engines?: { node?: string } };
    expect(manifest.engines?.node).toBe(">=22.12.0");
  });
});
