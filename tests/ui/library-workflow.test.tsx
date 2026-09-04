import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App";
import type { LibraryItem, ScanProgress } from "../../shared/types";

function audioItem(overrides: Partial<Extract<LibraryItem, { kind: "audio" }>> = {}): Extract<LibraryItem, { kind: "audio" }> {
  return {
    kind: "audio", path: "D:/音乐/track.flac", fileName: "track.flac", extension: ".flac",
    sizeBytes: 12_345_678, durationMs: 215_000, metadata: { common: { title: "Old title", artist: "Artist", album: "Album" }, raw: { TITLE: "Old title" }, durationMs: 215_000, format: "flac" },
    wholeTrackStatus: "suspected", ...overrides
  };
}

describe("library editing workflow", () => {
  let progressListener: ((progress: ScanProgress) => void) | undefined;
  beforeEach(() => {
    progressListener = undefined;
    window.musicId3 = {
      selectDirectory: vi.fn(async () => "D:/音乐"),
      scanDirectory: vi.fn(async () => ({ ok: true, scanId: "scan-1" })),
      readAudio: vi.fn(async () => audioItem().metadata),
      writeAudio: vi.fn(async (_path, patch) => ({ ok: true, metadata: { ...audioItem().metadata, common: { ...audioItem().metadata.common, ...patch.fields } } })),
      readCue: vi.fn(), saveCue: vi.fn(async () => ({ ok: true, path: "D:/音乐/album.cue", backupPath: "D:/音乐/album.cue.bak" })),
      searchMetadata: vi.fn(async () => [{ id: "mb-1", source: "musicbrainz", title: "New title", artist: "Artist", confidence: "high" }]),
      setProviderCookie: vi.fn(async () => undefined), testProviderCookie: vi.fn(async () => ({ ok: true, status: "configured" })),
      clearOnlineCache: vi.fn(async () => undefined),
      onScanProgress: vi.fn((listener) => { progressListener = listener; return () => { progressListener = undefined; }; })
    };
  });
  afterEach(() => cleanup());

  it("renders three panes and progressively adds scan results", async () => {
    render(<App />);
    expect(screen.getByRole("complementary", { name: /directories/i })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /library/i })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: /details/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /scan/i }));
    await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalledWith("D:/音乐"));
    progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: audioItem() });
    expect(await screen.findByText("track.flac")).toBeInTheDocument();
    expect(screen.getByText(/suspected/i)).toBeInTheDocument();
  });

  it("guides suspected whole-track files to CUE flow and supports override", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /scan/i }));
    await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled());
    progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: audioItem() });
    fireEvent.click(await screen.findByText("track.flac"));
    expect(screen.getByText(/whole-track cue candidate/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /use normal audio editing/i }));
    expect(screen.queryByText(/whole-track cue candidate/i)).not.toBeInTheDocument();
  });

  it("previews selected field diff and requires confirmation before audio write", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /scan/i }));
    await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled());
    progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: audioItem({ wholeTrackStatus: "normal" }) });
    fireEvent.click(await screen.findByText("track.flac"));
    fireEvent.change(screen.getByLabelText(/title value/i), { target: { value: "New title" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /title/i }));
    fireEvent.click(screen.getByRole("button", { name: /preview diff/i }));
    expect(screen.getByText(/old title/i)).toBeInTheDocument();
    expect(screen.getByText(/new title/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /write selected fields/i }));
    expect(window.musicId3.writeAudio).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /confirm write/i }));
    await waitFor(() => expect(window.musicId3.writeAudio).toHaveBeenCalled());
  });

  it("shows CUE save confirmation with backup notice", async () => {
    render(<App />);
    const cue: LibraryItem = { kind: "cue", path: "D:/音乐/album.cue", encoding: "gb18030", rawText: 'TITLE "Album"', parsed: { title: "Album", remarks: [], files: [], tracks: [], unknownLines: [] }, referencedFiles: [], missingReferencedFiles: [] };
    fireEvent.click(screen.getByRole("button", { name: /scan/i }));
    await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled());
    progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: cue });
    fireEvent.click(await screen.findByText("album.cue"));
    fireEvent.click(screen.getByRole("button", { name: /save cue/i }));
    expect(screen.getByText(/\.bak/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /confirm cue save/i }));
    await waitFor(() => expect(window.musicId3.saveCue).toHaveBeenCalled());
  });
});
