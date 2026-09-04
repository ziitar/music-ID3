import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
      cancelScan: vi.fn(async () => undefined),
      readAudio: vi.fn(async () => audioItem().metadata),
      writeAudio: vi.fn(async (_path, patch) => ({ ok: true, metadata: { ...audioItem().metadata, common: { ...audioItem().metadata.common, ...patch.fields } } })),
      readCue: vi.fn(), saveCue: vi.fn(async () => ({ ok: true, path: "D:/音乐/album.cue", backupPath: "D:/音乐/album.cue.bak" })),
      previewCue: vi.fn(async (path, rawText) => ({ path, rawText, encoding: "utf8", parsed: { title: rawText.includes("Edited") ? "Edited" : "Album", remarks: [], files: [{ path: "disc.flac" }], tracks: [{ number: 1, fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }], unknownLines: [] }, referencedFiles: [], missingReferencedFiles: [] })),
      buildCandidateCue: vi.fn(async () => ({ title: "Candidate release", performer: "Artist", remarks: [], files: [{ path: "track.flac" }], tracks: [{ number: 1, title: "First", indexes: [{ number: 1, time: "00:00:00" }] }], unknownLines: [] })),
      searchMetadata: vi.fn(async () => [{ id: "mb-1", source: "musicbrainz", title: "New title", artist: "Artist", confidence: "high" }]),
      getMetadataCandidate: vi.fn(async (_source, id) => ({ id, source: "musicbrainz", title: "New title", artist: "Artist", confidence: "high", cover: { mimeType: "image/jpeg", data: "AQID" } })),
      setProviderCookie: vi.fn(async () => undefined), testProviderCookie: vi.fn(async () => ({ ok: true, status: "configured" })),
      getProviderCookieStatus: vi.fn(async () => "unconfigured"),
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
    await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalledWith("D:/音乐", expect.any(String)));
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

  it("clears stale editor details when a new scan begins", async () => {
    render(<App />); fireEvent.click(screen.getByRole("button", { name: /scan/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled());
    progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: audioItem({ wholeTrackStatus: "normal" }) });
    fireEvent.click(await screen.findByText("track.flac")); expect(screen.getByLabelText(/title value/i)).toHaveValue("Old title");

    fireEvent.click(screen.getByRole("button", { name: /scan/i }));

    expect(screen.getByText(/select a file to inspect/i)).toBeInTheDocument();
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

  it("refreshes the library and editor from disk after a successful CUE save", async () => {
    const cue: LibraryItem = { kind: "cue", path: "D:/音乐/album.cue", encoding: "utf8", rawText: 'TITLE "Before"', parsed: { title: "Before", remarks: [], files: [], tracks: [], unknownLines: [] }, referencedFiles: [], missingReferencedFiles: [] };
    vi.mocked(window.musicId3.readCue).mockResolvedValue({ path: cue.path, encoding: "utf8", rawText: 'TITLE "After"', parsed: { title: "After", remarks: [], files: [{ path: "missing.flac" }], tracks: [], unknownLines: [] }, referencedFiles: ["D:/音乐/missing.flac"], missingReferencedFiles: ["D:/音乐/missing.flac"], parseError: "Missing TRACK" });
    render(<App />); fireEvent.click(screen.getByRole("button", { name: /scan/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled()); progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: cue }); fireEvent.click(await screen.findByText("album.cue")); fireEvent.click(screen.getByRole("button", { name: /save cue/i })); fireEvent.click(screen.getByRole("button", { name: /confirm cue save/i }));

    await waitFor(() => expect(window.musicId3.readCue).toHaveBeenCalledWith(cue.path));
    expect(await screen.findByText("Missing TRACK")).toBeInTheDocument();
    expect(screen.getByText(/missing references/i)).toHaveTextContent("missing.flac");
  });

  it("applies selected candidate fields and refreshes after confirmed write", async () => {
    render(<App />); fireEvent.click(screen.getByRole("button", { name: /scan/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled());
    progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: audioItem({ wholeTrackStatus: "normal" }) });
    fireEvent.click(await screen.findByText("track.flac")); fireEvent.change(screen.getByLabelText(/candidate query/i), { target: { value: "New" } }); fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
    expect(await screen.findByText("New title")).toBeInTheDocument(); fireEvent.click(screen.getByRole("button", { name: /apply candidate/i }));
    await screen.findByRole("button", { name: /confirm candidate write/i }); expect(screen.getAllByText(/old title/i).length).toBeGreaterThan(0); fireEvent.click(screen.getByRole("button", { name: /confirm candidate write/i }));
    await waitFor(() => expect(window.musicId3.writeAudio).toHaveBeenCalledWith("D:/音乐/track.flac", expect.objectContaining({ fields: expect.objectContaining({ title: "New title", artist: "Artist" }), selectedFields: expect.arrayContaining(["title", "artist"]) })));
    expect(window.musicId3.readAudio).toHaveBeenCalledWith("D:/音乐/track.flac");
    await waitFor(() => expect(screen.queryByRole("button", { name: /confirm candidate write/i })).not.toBeInTheDocument());
  });

  it("loads detailed candidate fields before applying selected cover art", async () => {
    vi.mocked(window.musicId3.searchMetadata).mockResolvedValue([{ id: "detail", source: "musicbrainz", title: "Search title", confidence: "medium" }]);
    vi.mocked(window.musicId3.getMetadataCandidate).mockResolvedValue({ id: "detail", source: "musicbrainz", title: "Detailed title", date: "2026", cover: { mimeType: "image/jpeg", data: "AQID" }, confidence: "high" });
    render(<App />); fireEvent.click(screen.getByRole("button", { name: /scan/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled()); progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: audioItem({ wholeTrackStatus: "normal" }) }); fireEvent.click(await screen.findByText("track.flac")); fireEvent.change(screen.getByLabelText(/candidate query/i), { target: { value: "detail" } }); fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
    await screen.findByText("Search title");
    const candidateRow = screen.getByRole("button", { name: /load candidate details/i }).closest(".candidate-row") as HTMLElement;
    expect(within(candidateRow).getByRole("checkbox", { name: /cover/i })).toBeDisabled();
    fireEvent.click(within(candidateRow).getByRole("button", { name: /load candidate details/i }));
    await waitFor(() => expect(within(candidateRow).getByRole("checkbox", { name: /cover/i })).toBeEnabled());
    expect(within(candidateRow).getByRole("checkbox", { name: /date/i })).toBeEnabled();
    fireEvent.click(within(candidateRow).getByRole("checkbox", { name: /cover/i }));
    fireEvent.click(within(candidateRow).getByRole("button", { name: /apply candidate/i }));
    fireEvent.click(await screen.findByRole("button", { name: /confirm candidate write/i }));
    await waitFor(() => expect(window.musicId3.writeAudio).toHaveBeenCalledWith("D:/音乐/track.flac", expect.objectContaining({ fields: expect.objectContaining({ cover: { mimeType: "image/jpeg", data: "AQID" } }), selectedFields: expect.arrayContaining(["cover"]) })));
  });

  it("offers only providers relevant to the selected item type", async () => {
    render(<App />); fireEvent.click(screen.getByRole("button", { name: /scan/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled()); progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: audioItem({ wholeTrackStatus: "normal" }) }); fireEvent.click(await screen.findByText("track.flac"));
    const audioProviders = within(screen.getByLabelText("provider"));
    expect(audioProviders.getAllByRole("option", { name: /musicbrainz|netease|qq music/i })).toHaveLength(3);
    expect(audioProviders.queryByRole("option", { name: /ctdb/i })).not.toBeInTheDocument();

    const cue: LibraryItem = { kind: "cue", path: "D:/音乐/album.cue", encoding: "utf8", rawText: "", parsed: { remarks: [], files: [], tracks: [], unknownLines: [] }, referencedFiles: [], missingReferencedFiles: [] };
    progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 2, item: cue }); fireEvent.click(await screen.findByText("album.cue"));
    const cueProviders = within(screen.getByLabelText("provider"));
    expect(cueProviders.getAllByRole("option", { name: /musicbrainz/i })).toHaveLength(1);
    expect(cueProviders.queryByRole("option", { name: /netease|qq music|ctdb/i })).not.toBeInTheDocument();
  });

  it("disables normal-audio candidate apply when no selected field is available", async () => {
    vi.mocked(window.musicId3.searchMetadata).mockResolvedValueOnce([{ id: "with-cover", source: "musicbrainz", title: "With cover", confidence: "high" }]).mockResolvedValueOnce([{ id: "without-cover", source: "musicbrainz", title: "Without cover", confidence: "high" }]);
    vi.mocked(window.musicId3.getMetadataCandidate).mockResolvedValue({ id: "with-cover", source: "musicbrainz", title: "With cover", cover: { mimeType: "image/jpeg", data: "AQID" }, confidence: "high" });
    render(<App />); fireEvent.click(screen.getByRole("button", { name: /scan/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled()); progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: audioItem({ wholeTrackStatus: "normal" }) }); fireEvent.click(await screen.findByText("track.flac")); fireEvent.change(screen.getByLabelText(/candidate query/i), { target: { value: "candidate" } }); fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
    const firstRow = (await screen.findByText("With cover")).closest(".candidate-row") as HTMLElement;
    fireEvent.click(within(firstRow).getByRole("button", { name: /load candidate details/i }));
    await waitFor(() => expect(within(firstRow).getByRole("checkbox", { name: /cover/i })).toBeEnabled());
    fireEvent.click(within(firstRow).getByRole("checkbox", { name: /title/i }));
    fireEvent.click(within(firstRow).getByRole("checkbox", { name: /cover/i }));
    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
    const secondRow = (await screen.findByText("Without cover")).closest(".candidate-row") as HTMLElement;
    expect(within(secondRow).getByRole("button", { name: /apply candidate/i })).toBeDisabled();
  });

  it("keeps candidate confirmation open and does not refresh after a rejected write", async () => {
    vi.mocked(window.musicId3.writeAudio).mockResolvedValue({ ok: false, error: "Write rejected" });
    render(<App />); fireEvent.click(screen.getByRole("button", { name: /scan/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled());
    progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: audioItem({ wholeTrackStatus: "normal" }) });
    fireEvent.click(await screen.findByText("track.flac")); fireEvent.change(screen.getByLabelText(/candidate query/i), { target: { value: "New" } }); fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /apply candidate/i })); fireEvent.click(await screen.findByRole("button", { name: /confirm candidate write/i }));

    expect(await screen.findByText("Write rejected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /confirm candidate write/i })).toBeInTheDocument();
    expect(window.musicId3.readAudio).not.toHaveBeenCalled();
  });

  it("includes replacement and removal CoverArt in audio write payloads", async () => {
    render(<App />); fireEvent.click(screen.getByRole("button", { name: /scan/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled()); progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: audioItem({ wholeTrackStatus: "normal" }) }); fireEvent.click(await screen.findByText("track.flac"));
    const file = new File([new Uint8Array([1, 2, 3])], "cover.png", { type: "image/png" }); fireEvent.change(screen.getByLabelText(/cover file/i), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByText(/image\/png/i)).toBeInTheDocument()); fireEvent.click(screen.getByRole("button", { name: /preview diff/i })); fireEvent.click(screen.getByRole("button", { name: /write selected fields/i })); fireEvent.click(screen.getByRole("button", { name: /confirm write/i }));
    await waitFor(() => expect(window.musicId3.writeAudio).toHaveBeenLastCalledWith("D:/音乐/track.flac", expect.objectContaining({ fields: { cover: { mimeType: "image/png", data: "AQID" } }, selectedFields: ["cover"] })));
    fireEvent.click(screen.getByRole("button", { name: /remove cover/i })); fireEvent.click(screen.getByRole("button", { name: /confirm clear/i })); fireEvent.click(screen.getByRole("button", { name: /preview diff/i })); fireEvent.click(screen.getByRole("button", { name: /write selected fields/i })); fireEvent.click(screen.getByRole("button", { name: /confirm write/i }));
    await waitFor(() => expect(window.musicId3.writeAudio).toHaveBeenLastCalledWith("D:/音乐/track.flac", expect.objectContaining({ fields: { cover: undefined }, selectedFields: ["cover"] })));
  });

  it("parses raw CUE edits and saves the validated document with selected encoding", async () => {
    render(<App />); const cue: LibraryItem = { kind: "cue", path: "D:/音乐/album.cue", encoding: "gb18030", rawText: 'TITLE "Album"', parsed: { title: "Album", remarks: [], files: [], tracks: [], unknownLines: [] }, referencedFiles: [], missingReferencedFiles: [], candidateEncodings: ["utf8", "gb18030"] }; fireEvent.click(screen.getByRole("button", { name: /scan/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled()); progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: cue }); fireEvent.click(await screen.findByText("album.cue")); fireEvent.click(screen.getByRole("button", { name: /^raw$/i })); fireEvent.change(screen.getByLabelText(/raw cue/i), { target: { value: 'TITLE "Edited"\nFILE "disc.flac" WAVE\n TRACK 01 AUDIO\n  INDEX 01 00:00:00' } }); fireEvent.blur(screen.getByLabelText(/raw cue/i)); await waitFor(() => expect(window.musicId3.previewCue).toHaveBeenCalled()); fireEvent.change(screen.getByLabelText(/encoding/i), { target: { value: "utf8" } }); fireEvent.click(screen.getByRole("button", { name: /save cue/i })); fireEvent.click(screen.getByRole("button", { name: /confirm cue save/i }));
    await waitFor(() => expect(window.musicId3.saveCue).toHaveBeenCalledWith(expect.objectContaining({ encoding: "utf8", document: expect.objectContaining({ title: "Edited" }) })));
  });

  it("saves only the newest raw CUE preview when validations resolve out of order", async () => {
    let resolveFirst!: (value: Awaited<ReturnType<typeof window.musicId3.previewCue>>) => void;
    let resolveSecond!: (value: Awaited<ReturnType<typeof window.musicId3.previewCue>>) => void;
    vi.mocked(window.musicId3.previewCue)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve; }));
    const cue: LibraryItem = { kind: "cue", path: "D:/音乐/album.cue", encoding: "utf8", rawText: 'TITLE "Album"', parsed: { title: "Album", remarks: [], files: [], tracks: [], unknownLines: [] }, referencedFiles: [], missingReferencedFiles: [] };
    render(<App />); fireEvent.click(screen.getByRole("button", { name: /scan/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled()); progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: cue }); fireEvent.click(await screen.findByText("album.cue")); fireEvent.click(screen.getByRole("button", { name: /^raw$/i }));
    const textarea = screen.getByLabelText(/raw cue/i);
    fireEvent.change(textarea, { target: { value: 'TITLE "First"' } }); fireEvent.blur(textarea);
    fireEvent.change(textarea, { target: { value: 'TITLE "Second"' } }); fireEvent.blur(textarea);
    resolveSecond({ ...cue, rawText: 'TITLE "Second"', parsed: { ...cue.parsed, title: "Second" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /save cue/i })).toBeEnabled());
    resolveFirst({ ...cue, rawText: 'TITLE "First"', parsed: { ...cue.parsed, title: "First" } });
    await Promise.resolve();
    fireEvent.click(screen.getByRole("button", { name: /save cue/i })); fireEvent.click(screen.getByRole("button", { name: /confirm cue save/i }));
    await waitFor(() => expect(window.musicId3.saveCue).toHaveBeenCalledWith(expect.objectContaining({ rawText: 'TITLE "Second"', document: expect.objectContaining({ title: "Second" }) })));
  });

  it("mutates structured CUE fields in the saved document", async () => {
    render(<App />); const cue: LibraryItem = { kind: "cue", path: "D:/音乐/album.cue", encoding: "utf8", rawText: 'TITLE "Album"', parsed: { title: "Album", remarks: [], files: [{ path: "old.flac" }], tracks: [{ number: 1, title: "Old track", indexes: [{ number: 1, time: "00:00:00" }] }], unknownLines: [] }, referencedFiles: [], missingReferencedFiles: [] }; fireEvent.click(screen.getByRole("button", { name: /scan/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled()); progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: cue }); fireEvent.click(await screen.findByText("album.cue")); fireEvent.change(screen.getByLabelText(/cue album title/i), { target: { value: "Edited album" } }); fireEvent.change(screen.getByLabelText(/cue file 1/i), { target: { value: "new.flac" } }); fireEvent.change(screen.getByLabelText(/track 1 title/i), { target: { value: "Edited track" } }); fireEvent.click(screen.getByRole("button", { name: /save cue/i })); fireEvent.click(screen.getByRole("button", { name: /confirm cue save/i }));
    await waitFor(() => expect(window.musicId3.saveCue).toHaveBeenCalledWith(expect.objectContaining({ rawText: "", document: expect.objectContaining({ title: "Edited album", files: [expect.objectContaining({ path: "new.flac" })], tracks: [expect.objectContaining({ title: "Edited track" })] }) })));
  });

  it("opens a MusicBrainz release as a CUE draft for a suspected whole-track", async () => {
    vi.mocked(window.musicId3.searchMetadata).mockResolvedValue([{ id: "release", source: "musicbrainz", title: "Candidate release", artist: "Artist", trackCount: 1, confidence: "low" }]);
    vi.mocked(window.musicId3.getMetadataCandidate).mockResolvedValue({ id: "release", source: "musicbrainz", title: "Candidate release", artist: "Artist", offsets: [150], tracks: [{ number: 1, title: "First" }], confidence: "high", cover: { mimeType: "image/jpeg", data: "AQID" } });
    render(<App />); fireEvent.click(screen.getByRole("button", { name: /scan/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled()); progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: audioItem() }); fireEvent.click(await screen.findByText("track.flac")); fireEvent.change(screen.getByLabelText(/candidate query/i), { target: { value: "release" } }); fireEvent.click(screen.getByRole("button", { name: /^search$/i })); await screen.findByText("Candidate release"); fireEvent.click(screen.getByRole("button", { name: /apply candidate/i }));
    expect(await screen.findByDisplayValue("Candidate release")).toBeInTheDocument(); expect(window.musicId3.getMetadataCandidate).toHaveBeenCalledWith("musicbrainz", "release"); expect(window.musicId3.buildCandidateCue).toHaveBeenCalledWith(expect.objectContaining({ audioPath: "D:/音乐/track.flac", candidate: expect.objectContaining({ offsets: [150] }) })); expect(screen.getByText(/musicbrainz release/i)).toBeInTheDocument(); expect(screen.getByAltText("candidate cover")).toBeInTheDocument();
  });

  it("blocks invalid raw CUE saves and shows validation errors", async () => {
    vi.mocked(window.musicId3.previewCue).mockResolvedValue({ path: "D:/音乐/album.cue", encoding: "utf8", rawText: "BROKEN", parsed: { remarks: [], files: [], tracks: [], unknownLines: [] }, referencedFiles: [], missingReferencedFiles: [], parseError: "Missing TRACK" });
    render(<App />); const cue: LibraryItem = { kind: "cue", path: "D:/音乐/album.cue", encoding: "utf8", rawText: "", parsed: { remarks: [], files: [], tracks: [], unknownLines: [] }, referencedFiles: [], missingReferencedFiles: [] }; fireEvent.click(screen.getByRole("button", { name: /scan/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled()); progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: cue }); fireEvent.click(await screen.findByText("album.cue")); fireEvent.click(screen.getByRole("button", { name: /^raw$/i })); fireEvent.change(screen.getByLabelText(/raw cue/i), { target: { value: "BROKEN" } }); fireEvent.blur(screen.getByLabelText(/raw cue/i)); expect(await screen.findByText("Missing TRACK")).toBeInTheDocument(); expect(screen.getByRole("button", { name: /save cue/i })).toBeDisabled();
  });

  it("loads redacted Cookie status and displays search and cache errors", async () => {
    vi.mocked(window.musicId3.getProviderCookieStatus).mockResolvedValue("configured"); vi.mocked(window.musicId3.searchMetadata).mockRejectedValue(new Error("secret should not render")); vi.mocked(window.musicId3.clearOnlineCache).mockRejectedValue(new Error("cache internals"));
    render(<App />); expect(await screen.findByLabelText(/cookie status/i)).toHaveTextContent("configured"); fireEvent.click(screen.getByText("Settings")); fireEvent.click(screen.getByRole("button", { name: /clear online cache/i })); expect(await screen.findByText(/unable to clear online cache/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /scan/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled()); progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: audioItem({ wholeTrackStatus: "normal" }) }); fireEvent.click(await screen.findByText("track.flac")); fireEvent.change(screen.getByLabelText(/candidate query/i), { target: { value: "query" } }); fireEvent.click(screen.getByRole("button", { name: /^search$/i })); expect((await screen.findAllByText(/metadata search failed/i)).length).toBeGreaterThan(0); expect(screen.queryByText(/secret should not render/i)).not.toBeInTheDocument();
  });

  it("keeps Cookie configuration status separate from connectivity results", async () => {
    vi.mocked(window.musicId3.getProviderCookieStatus).mockResolvedValue("configured");
    vi.mocked(window.musicId3.testProviderCookie).mockResolvedValue({ ok: false, error: "Provider connectivity check failed" });
    render(<App />); fireEvent.click(screen.getByText("Settings"));
    expect(await screen.findByLabelText(/cookie status/i)).toHaveTextContent("configured");
    fireEvent.click(screen.getByRole("button", { name: /^test$/i }));
    expect(await screen.findByText(/provider connectivity check failed/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/cookie status/i)).toHaveTextContent("configured");

    vi.mocked(window.musicId3.getProviderCookieStatus).mockResolvedValue("unconfigured");
    fireEvent.click(screen.getByRole("button", { name: /^clear$/i }));
    await waitFor(() => expect(window.musicId3.getProviderCookieStatus).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText(/cookie status/i)).toHaveTextContent("unconfigured");
  });
});
