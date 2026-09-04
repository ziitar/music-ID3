import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCandidateCue } from "../../electron/services/cue-candidate";
import { serializeCue } from "../../electron/services/cue-service";
import { framesToCueTime } from "../../shared/cue-time";

describe("candidate CUE generation", () => {
  it("converts CD frames at 75 frames per second", () => {
    expect(framesToCueTime(0)).toBe("00:00:00");
    expect(framesToCueTime(74)).toBe("00:00:74");
    expect(framesToCueTime(75)).toBe("00:01:00");
    expect(framesToCueTime(4_500)).toBe("01:00:00");
    expect(() => framesToCueTime(-1)).toThrow(/non-negative integer/i);
  });

  it("builds local INDEX 01 times relative to the first MusicBrainz offset", () => {
    const audioPath = path.join("D:/Music", "Miles Davis", "Kind of Blue.flac");
    const cue = buildCandidateCue({
      audioPath,
      album: "Kind of Blue",
      performer: "Miles Davis",
      date: "1959",
      offsets: [150, 13_650, 34_650],
      tracks: [
        { title: "So What" },
        { title: "Freddie Freeloader", performer: "Miles Davis Sextet" },
        { title: "Blue in Green" }
      ]
    });

    expect(cue).toMatchObject({
      title: "Kind of Blue",
      performer: "Miles Davis",
      remarks: ["DATE 1959"],
      files: [{ path: "Kind of Blue.flac", type: "WAVE" }],
      tracks: [
        { number: 1, fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] },
        { number: 2, fileIndex: 0, performer: "Miles Davis Sextet", indexes: [{ number: 1, time: "03:00:00" }] },
        { number: 3, fileIndex: 0, indexes: [{ number: 1, time: "07:40:00" }] }
      ]
    });
    expect(serializeCue(cue, "utf8").toString("utf8")).toContain('FILE "Kind of Blue.flac" WAVE');
  });

  it("rejects missing and non-monotonic INDEX 01 offsets", () => {
    const base = {
      audioPath: "D:/Music/disc.flac",
      album: "Album",
      tracks: [{ title: "One" }, { title: "Two" }]
    };

    expect(() => buildCandidateCue({ ...base, offsets: [150] })).toThrow(/one offset per track/i);
    expect(() => buildCandidateCue({ ...base, offsets: [150, 149] })).toThrow(/strictly increasing/i);
  });
});
