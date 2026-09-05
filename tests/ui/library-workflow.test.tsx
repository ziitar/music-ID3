import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App";
import { editorStore } from "../../src/stores/editor-store";
import { libraryStore } from "../../src/stores/library-store";
import type { LibraryItem, ScanProgress } from "../../shared/types";

let preparedCueSequence = 0;

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
      setWholeTrackOverride: vi.fn(async () => undefined),
      readAudio: vi.fn(async () => audioItem().metadata),
      writeAudio: vi.fn(async (_path, patch) => ({ ok: true, metadata: { ...audioItem().metadata, common: { ...audioItem().metadata.common, ...patch.fields } } })),
      readCue: vi.fn(), prepareCueSave: vi.fn(async () => `prepared-cue-save-${++preparedCueSequence}`), saveCue: vi.fn(async () => ({ ok: true, path: "D:/音乐/album.cue", backupPath: "D:/音乐/album.cue.bak" })),
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
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("renders three panes and progressively adds scan results", async () => {
    render(<App />);
    expect(screen.getByRole("complementary", { name: /directories/i })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /library/i })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: /details/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /scan/i }));
    await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalledWith("D:/音乐", expect.any(String)));
    progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: audioItem() });
    expect(await screen.findByText("track.flac")).toBeInTheDocument();
    expect(screen.getByTestId("library-row")).toHaveTextContent("suspected");
  });

  it("guides suspected whole-track files to CUE flow and supports override", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /scan/i }));
    await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled());
    progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: audioItem() });
    fireEvent.click(await screen.findByText("track.flac"));
    expect(screen.getByText(/whole-track cue candidate/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /use normal audio editing/i }));
    await waitFor(() => expect(screen.queryByText(/whole-track cue candidate/i)).not.toBeInTheDocument());
  });

  it("disables every ordinary tag mutation for suspected audio until main accepts the override", async () => {
    let acceptOverride!: () => void;
    vi.mocked(window.musicId3.setWholeTrackOverride).mockImplementation(() => new Promise<void>((resolve) => { acceptOverride = resolve; }));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /scan/i }));
    await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled());
    progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: audioItem() });
    fireEvent.click(await screen.findByText("track.flac"));

    expect(screen.getByRole("checkbox", { name: /^title$/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /remove cover/i })).toBeDisabled();
    expect(screen.getByLabelText(/cover file/i)).toBeDisabled();
    expect(screen.getByRole("button", { name: /preview diff/i })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /use normal audio editing/i }));
    expect(window.musicId3.setWholeTrackOverride).toHaveBeenCalledWith("D:/音乐/track.flac", true);
    expect(screen.getByLabelText(/title value/i)).toBeDisabled();
    acceptOverride();
    await waitFor(() => expect(screen.getByLabelText(/title value/i)).toBeEnabled());
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
    expect(await screen.findByText(/\.bak/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /confirm cue save/i }));
    await waitFor(() => expect(window.musicId3.saveCue).toHaveBeenCalled());
  });

  it("consumes CUE confirmation synchronously so rapid repeated activation invokes one save token", async () => {
    vi.mocked(window.musicId3.saveCue).mockResolvedValue({ ok: true, path: "D:/音乐/album.cue", backupPath: "D:/音乐/album.cue.bak" });
    const cue: LibraryItem = { kind: "cue", path: "D:/音乐/album.cue", encoding: "utf8", rawText: "", parsed: { remarks: [], files: [], tracks: [], unknownLines: [] }, referencedFiles: [], missingReferencedFiles: [] };
    render(<App />); fireEvent.click(screen.getByRole("button", { name: /scan/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled()); progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: cue }); fireEvent.click(await screen.findByText("album.cue")); fireEvent.click(screen.getByRole("button", { name: /save cue/i }));
    const confirmation = await screen.findByRole("button", { name: /confirm cue save/i });

    fireEvent.click(confirmation);
    fireEvent.click(confirmation);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(window.musicId3.saveCue).toHaveBeenCalledTimes(1);
    expect(window.musicId3.prepareCueSave).toHaveBeenCalledTimes(1);
    expect(vi.mocked(window.musicId3.saveCue).mock.calls[0][0]).toMatchObject({ confirmationToken: expect.stringMatching(/^prepared-cue-save-/) });
  });

  it("refreshes the library and editor from disk after a successful CUE save", async () => {
    const cue: LibraryItem = { kind: "cue", path: "D:/音乐/album.cue", encoding: "utf8", rawText: 'TITLE "Before"', parsed: { title: "Before", remarks: [], files: [], tracks: [], unknownLines: [] }, referencedFiles: [], missingReferencedFiles: [] };
    vi.mocked(window.musicId3.readCue).mockResolvedValue({ path: cue.path, encoding: "utf8", rawText: 'TITLE "After"', parsed: { title: "After", remarks: [], files: [{ path: "missing.flac" }], tracks: [], unknownLines: [] }, referencedFiles: ["D:/音乐/missing.flac"], missingReferencedFiles: ["D:/音乐/missing.flac"], parseError: "Missing TRACK" });
    render(<App />); fireEvent.click(screen.getByRole("button", { name: /scan/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled()); progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: cue }); fireEvent.click(await screen.findByText("album.cue")); fireEvent.click(screen.getByRole("button", { name: /save cue/i })); fireEvent.click(await screen.findByRole("button", { name: /confirm cue save/i }));

    await waitFor(() => expect(window.musicId3.readCue).toHaveBeenCalledWith(cue.path));
    expect(await screen.findByText("Missing TRACK")).toBeInTheDocument();
    expect(screen.getByText(/missing references/i)).toHaveTextContent("missing.flac");
  });

  it("refreshes a saved CUE in the library without replacing a newly selected editor", async () => {
    let resolveSave!: (value: Awaited<ReturnType<typeof window.musicId3.saveCue>>) => void;
    vi.mocked(window.musicId3.saveCue).mockImplementation(() => new Promise((resolve) => { resolveSave = resolve; }));
    const cueA: LibraryItem = { kind: "cue", path: "D:/音乐/a.cue", encoding: "utf8", rawText: "", parsed: { title: "A", remarks: [], files: [], tracks: [], unknownLines: [] }, referencedFiles: [], missingReferencedFiles: [] };
    const cueB: LibraryItem = { kind: "cue", path: "D:/音乐/b.cue", encoding: "utf8", rawText: "", parsed: { title: "B", remarks: [], files: [], tracks: [], unknownLines: [] }, referencedFiles: [], missingReferencedFiles: [] };
    vi.mocked(window.musicId3.readCue).mockResolvedValue({ ...cueA, rawText: 'TITLE "Refreshed A"', parsed: { ...cueA.parsed, title: "Refreshed A" } });
    render(<App />); fireEvent.click(screen.getByRole("button", { name: /scan/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled()); progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: cueA }); progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 2, item: cueB });
    fireEvent.click(await screen.findByText("a.cue")); fireEvent.click(screen.getByRole("button", { name: /save cue/i })); fireEvent.click(await screen.findByRole("button", { name: /confirm cue save/i })); fireEvent.click(screen.getByText("b.cue")); resolveSave({ ok: true, path: cueA.path, backupPath: `${cueA.path}.bak` });

    await waitFor(() => expect(window.musicId3.readCue).toHaveBeenCalledWith(cueA.path));
    expect(editorStore.getState().item?.path).toBe(cueB.path);
    expect(screen.getByLabelText(/cue album title/i)).toHaveValue("B");
    expect(libraryStore.getState().items.find((entry) => entry.path === cueA.path)).toMatchObject({ parsed: { title: "Refreshed A" } });
  });

  it("does not reread or reinsert a saved CUE after a new root scan starts", async () => {
    let resolveSave!: (value: Awaited<ReturnType<typeof window.musicId3.saveCue>>) => void;
    vi.mocked(window.musicId3.saveCue).mockImplementation(() => new Promise((resolve) => { resolveSave = resolve; }));
    vi.mocked(window.musicId3.selectDirectory).mockResolvedValueOnce("D:/音乐").mockResolvedValueOnce("D:/new");
    const cue: LibraryItem = { kind: "cue", path: "D:/音乐/old.cue", encoding: "utf8", rawText: "", parsed: { title: "Old", remarks: [], files: [], tracks: [], unknownLines: [] }, referencedFiles: [], missingReferencedFiles: [] };
    render(<App />); fireEvent.click(screen.getByRole("button", { name: /scan/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalledTimes(1)); progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: cue }); fireEvent.click(await screen.findByText("old.cue")); fireEvent.click(screen.getByRole("button", { name: /save cue/i })); fireEvent.click(await screen.findByRole("button", { name: /confirm cue save/i }));
    fireEvent.click(screen.getByRole("button", { name: /scan folder/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalledTimes(2)); resolveSave({ ok: true, path: cue.path, backupPath: `${cue.path}.bak` }); await Promise.resolve(); await Promise.resolve();

    expect(window.musicId3.readCue).not.toHaveBeenCalled();
    expect(libraryStore.getState().items).toEqual([]);
    expect(editorStore.getState().item).toBeUndefined();
  });

  it("keeps the current CUE and shows a safe error when post-save reread fails", async () => {
    vi.mocked(window.musicId3.readCue).mockRejectedValue(new Error("private read failure"));
    const cue: LibraryItem = { kind: "cue", path: "D:/音乐/album.cue", encoding: "utf8", rawText: "", parsed: { title: "Album", remarks: [], files: [], tracks: [], unknownLines: [] }, referencedFiles: [], missingReferencedFiles: [] };
    render(<App />); fireEvent.click(screen.getByRole("button", { name: /scan/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled()); progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: cue }); fireEvent.click(await screen.findByText("album.cue")); fireEvent.click(screen.getByRole("button", { name: /save cue/i })); fireEvent.click(await screen.findByRole("button", { name: /confirm cue save/i }));

    expect(await screen.findByText("Unable to refresh CUE")).toBeInTheDocument();
    expect(screen.queryByText(/private read failure/i)).not.toBeInTheDocument();
    expect(editorStore.getState().item?.path).toBe(cue.path);
  });

  it("inserts and opens a generated CUE after saving a suspected audio candidate", async () => {
    const generatedPath = "D:/音乐/track.flac.cue";
    vi.mocked(window.musicId3.saveCue).mockResolvedValue({ ok: true, path: generatedPath, backupPath: `${generatedPath}.bak` });
    vi.mocked(window.musicId3.readCue).mockResolvedValue({ path: generatedPath, encoding: "utf8", rawText: 'TITLE "Generated"', parsed: { title: "Generated", remarks: [], files: [{ path: "track.flac" }], tracks: [{ number: 1, indexes: [{ number: 1, time: "00:00:00" }] }], unknownLines: [] }, referencedFiles: ["D:/音乐/track.flac"], missingReferencedFiles: [] });
    render(<App />); fireEvent.click(screen.getByRole("button", { name: /scan/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled()); progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: audioItem() }); fireEvent.click(await screen.findByText("track.flac")); fireEvent.change(screen.getByLabelText(/candidate query/i), { target: { value: "release" } }); fireEvent.click(screen.getByRole("button", { name: /^search$/i })); fireEvent.click(await screen.findByRole("button", { name: /apply candidate/i })); fireEvent.click(await screen.findByRole("button", { name: /save cue/i })); fireEvent.click(await screen.findByRole("button", { name: /confirm cue save/i }));

    await waitFor(() => expect(window.musicId3.readCue).toHaveBeenCalledWith(generatedPath));
    expect(libraryStore.getState()).toMatchObject({ selectedPath: generatedPath, items: expect.arrayContaining([expect.objectContaining({ kind: "cue", path: generatedPath })]) });
    expect(editorStore.getState().item).toMatchObject({ kind: "cue", path: generatedPath, parsed: { title: "Generated" } });
    expect(screen.getByLabelText(/cue album title/i)).toHaveValue("Generated");
  });

  it("does not insert a generated CUE when its save finishes after a new root starts", async () => {
    let resolveSave!: (value: Awaited<ReturnType<typeof window.musicId3.saveCue>>) => void;
    vi.mocked(window.musicId3.saveCue).mockImplementation(() => new Promise((resolve) => { resolveSave = resolve; }));
    vi.mocked(window.musicId3.selectDirectory).mockResolvedValueOnce("D:/音乐").mockResolvedValueOnce("D:/new");
    render(<App />); fireEvent.click(screen.getByRole("button", { name: /scan/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalledTimes(1)); progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: audioItem() }); fireEvent.click(await screen.findByText("track.flac")); fireEvent.change(screen.getByLabelText(/candidate query/i), { target: { value: "release" } }); fireEvent.click(screen.getByRole("button", { name: /^search$/i })); fireEvent.click(await screen.findByRole("button", { name: /apply candidate/i })); fireEvent.click(await screen.findByRole("button", { name: /save cue/i })); fireEvent.click(await screen.findByRole("button", { name: /confirm cue save/i }));
    fireEvent.click(screen.getByRole("button", { name: /scan folder/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalledTimes(2)); resolveSave({ ok: true, path: "D:/音乐/track.flac.cue", backupPath: "D:/音乐/track.flac.cue.bak" }); await Promise.resolve(); await Promise.resolve();

    expect(window.musicId3.readCue).not.toHaveBeenCalled();
    expect(libraryStore.getState().items).toEqual([]);
    expect(editorStore.getState().item).toBeUndefined();
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
    vi.mocked(window.musicId3.getMetadataCandidate).mockResolvedValueOnce({ id: "detail", source: "musicbrainz", title: "Detailed title", date: "2026", cover: { mimeType: "image/jpeg", data: "AQID" }, confidence: "high" }).mockRejectedValueOnce(new Error("second cover request failed"));
    render(<App />); fireEvent.click(screen.getByRole("button", { name: /scan/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled()); progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: audioItem({ wholeTrackStatus: "normal" }) }); fireEvent.click(await screen.findByText("track.flac")); fireEvent.change(screen.getByLabelText(/candidate query/i), { target: { value: "detail" } }); fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
    await screen.findByText("Search title");
    const candidateRow = screen.getByRole("button", { name: /load candidate details/i }).closest(".candidate-row") as HTMLElement;
    expect(within(candidateRow).getByRole("checkbox", { name: /cover/i })).toBeDisabled();
    fireEvent.click(within(candidateRow).getByRole("button", { name: /load candidate details/i }));
    await waitFor(() => expect(within(candidateRow).getByRole("checkbox", { name: /cover/i })).toBeEnabled());
    expect(within(candidateRow).getByRole("checkbox", { name: /date/i })).toBeEnabled();
    fireEvent.click(within(candidateRow).getByRole("checkbox", { name: /cover/i }));
    fireEvent.click(within(candidateRow).getByRole("button", { name: /apply candidate/i }));
    expect(window.musicId3.getMetadataCandidate).toHaveBeenCalledTimes(1);
    fireEvent.click(await screen.findByRole("button", { name: /confirm candidate write/i }));
    await waitFor(() => expect(window.musicId3.writeAudio).toHaveBeenCalledWith("D:/音乐/track.flac", expect.objectContaining({ fields: expect.objectContaining({ cover: { mimeType: "image/jpeg", data: "AQID" } }), selectedFields: expect.arrayContaining(["cover"]) })));
  });

  it("keeps a newly selected editor while a confirmed candidate write refreshes its original library item", async () => {
    let resolveWrite!: (value: Awaited<ReturnType<typeof window.musicId3.writeAudio>>) => void;
    vi.mocked(window.musicId3.writeAudio).mockImplementation(() => new Promise((resolve) => { resolveWrite = resolve; }));
    vi.mocked(window.musicId3.readAudio).mockResolvedValue({ common: { title: "Refreshed A" }, raw: {}, durationMs: 1 });
    render(<App />); fireEvent.click(screen.getByRole("button", { name: /scan/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled());
    progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: audioItem({ path: "D:/音乐/a.flac", fileName: "a.flac", wholeTrackStatus: "normal" }) });
    progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 2, item: audioItem({ path: "D:/音乐/b.flac", fileName: "b.flac", metadata: { ...audioItem().metadata, common: { title: "B title" } }, wholeTrackStatus: "normal" }) });
    fireEvent.click(await screen.findByText("a.flac")); fireEvent.change(screen.getByLabelText(/candidate query/i), { target: { value: "A" } }); fireEvent.click(screen.getByRole("button", { name: /^search$/i })); fireEvent.click(await screen.findByRole("button", { name: /apply candidate/i })); fireEvent.click(await screen.findByRole("button", { name: /confirm candidate write/i }));
    fireEvent.click(screen.getByText("b.flac"));
    resolveWrite({ ok: true, metadata: { common: { title: "Written A" }, raw: {}, durationMs: 1 } });

    await waitFor(() => expect(window.musicId3.readAudio).toHaveBeenCalledWith("D:/音乐/a.flac"));
    expect(screen.getByLabelText(/title value/i)).toHaveValue("B title");
    expect(editorStore.getState().item?.path).toBe("D:/音乐/b.flac");
    expect(libraryStore.getState().items.find((item) => item.path.endsWith("a.flac"))).toMatchObject({ metadata: { common: { title: "Refreshed A" } } });
  });

  it("keeps returned candidate-write metadata on the original library item when refresh fails", async () => {
    let resolveWrite!: (value: Awaited<ReturnType<typeof window.musicId3.writeAudio>>) => void;
    vi.mocked(window.musicId3.writeAudio).mockImplementation(() => new Promise((resolve) => { resolveWrite = resolve; }));
    vi.mocked(window.musicId3.readAudio).mockRejectedValue(new Error("refresh failed"));
    render(<App />); fireEvent.click(screen.getByRole("button", { name: /scan/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled());
    progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: audioItem({ path: "D:/音乐/a.flac", fileName: "a.flac", wholeTrackStatus: "normal" }) }); progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 2, item: audioItem({ path: "D:/音乐/b.flac", fileName: "b.flac", metadata: { ...audioItem().metadata, common: { title: "B title" } }, wholeTrackStatus: "normal" }) });
    fireEvent.click(await screen.findByText("a.flac")); fireEvent.change(screen.getByLabelText(/candidate query/i), { target: { value: "A" } }); fireEvent.click(screen.getByRole("button", { name: /^search$/i })); fireEvent.click(await screen.findByRole("button", { name: /apply candidate/i })); fireEvent.click(await screen.findByRole("button", { name: /confirm candidate write/i })); fireEvent.click(screen.getByText("b.flac")); resolveWrite({ ok: true, metadata: { common: { title: "Written A" }, raw: {}, durationMs: 1 } });

    await waitFor(() => expect(window.musicId3.readAudio).toHaveBeenCalledWith("D:/音乐/a.flac"));
    expect(libraryStore.getState().items.find((item) => item.path.endsWith("a.flac"))).toMatchObject({ metadata: { common: { title: "Written A" } } });
    expect(editorStore.getState().item?.path).toBe("D:/音乐/b.flac");
  });

  it("keeps candidate detail completion active through StrictMode effect replay", async () => {
    render(<StrictMode><App /></StrictMode>);
    fireEvent.click(screen.getByRole("button", { name: /scan/i }));
    await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled());
    progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: audioItem({ wholeTrackStatus: "normal" }) });
    fireEvent.click(await screen.findByText("track.flac"));
    fireEvent.change(screen.getByLabelText(/candidate query/i), { target: { value: "details" } });
    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /load candidate details/i }));

    await waitFor(() => expect(window.musicId3.getMetadataCandidate).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("button", { name: /load candidate details/i })).not.toBeInTheDocument());
  });

  it("does not capture a candidate write confirmation after unmount", async () => {
    let resolveCandidate!: (value: Awaited<ReturnType<typeof window.musicId3.getMetadataCandidate>>) => void;
    vi.mocked(window.musicId3.getMetadataCandidate).mockImplementation(() => new Promise((resolve) => { resolveCandidate = resolve; }));
    const captureConfirmation = vi.spyOn(editorStore, "captureAudioWriteConfirmation");
    try {
      const view = render(<App />);
      fireEvent.click(screen.getByRole("button", { name: /scan/i }));
      await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled());
      progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: audioItem({ wholeTrackStatus: "normal" }) });
      fireEvent.click(await screen.findByText("track.flac"));
      fireEvent.change(screen.getByLabelText(/candidate query/i), { target: { value: "candidate" } });
      fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
      fireEvent.click(await screen.findByRole("button", { name: /apply candidate/i }));
      await waitFor(() => expect(window.musicId3.getMetadataCandidate).toHaveBeenCalled());

      view.unmount();
      await act(async () => {
        resolveCandidate({ id: "mb-1", source: "musicbrainz", title: "Resolved after unmount", artist: "Artist", confidence: "high" });
        await Promise.resolve();
      });

      expect(captureConfirmation).not.toHaveBeenCalled();
    } finally {
      captureConfirmation.mockRestore();
    }
  });

  it("invalidates a manual write confirmation when selection or the editor generation changes", async () => {
    render(<App />); fireEvent.click(screen.getByRole("button", { name: /scan/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled()); progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: audioItem({ wholeTrackStatus: "normal" }) }); fireEvent.click(await screen.findByText("track.flac")); fireEvent.change(screen.getByLabelText(/title value/i), { target: { value: "Changed" } }); fireEvent.click(screen.getByRole("checkbox", { name: /title/i })); fireEvent.click(screen.getByRole("button", { name: /preview diff/i })); fireEvent.click(screen.getByRole("button", { name: /write selected fields/i }));

    const staleConfirmation = editorStore.captureAudioWriteConfirmation();
    fireEvent.click(screen.getByRole("checkbox", { name: /title/i }));
    await editorStore.confirmAudioWrite(staleConfirmation);
    expect(screen.queryByRole("button", { name: /confirm write/i })).not.toBeInTheDocument();
    expect(window.musicId3.writeAudio).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox", { name: /title/i })); fireEvent.click(screen.getByRole("button", { name: /preview diff/i })); fireEvent.click(screen.getByRole("button", { name: /write selected fields/i }));
    act(() => editorStore.setItem(audioItem({ metadata: { ...audioItem().metadata, common: { title: "Replacement" } }, wholeTrackStatus: "normal" })));
    expect(screen.queryByRole("button", { name: /confirm write/i })).not.toBeInTheDocument();
    expect(window.musicId3.writeAudio).not.toHaveBeenCalled();
  });

  it("invalidates candidate confirmation on same-path editor replacement", async () => {
    render(<App />); fireEvent.click(screen.getByRole("button", { name: /scan/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled()); progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: audioItem({ wholeTrackStatus: "normal" }) }); fireEvent.click(await screen.findByText("track.flac")); fireEvent.change(screen.getByLabelText(/candidate query/i), { target: { value: "New" } }); fireEvent.click(screen.getByRole("button", { name: /^search$/i })); fireEvent.click(await screen.findByRole("button", { name: /apply candidate/i })); await screen.findByRole("button", { name: /confirm candidate write/i });

    act(() => editorStore.setItem(audioItem({ metadata: { ...audioItem().metadata, common: { title: "Replacement" } }, wholeTrackStatus: "normal" })));

    expect(screen.queryByRole("button", { name: /confirm candidate write/i })).not.toBeInTheDocument();
    expect(window.musicId3.writeAudio).not.toHaveBeenCalled();
  });

  it("ignores stale cover reads and clears a current cover-read error after success", async () => {
    const readers: Array<{ result: ArrayBuffer; onload: null | (() => void); onerror: null | (() => void) }> = [];
    class MockFileReader {
      result = new Uint8Array([1, 2, 3]).buffer; onload: null | (() => void) = null; onerror: null | (() => void) = null;
      constructor() { readers.push(this); }
      readAsArrayBuffer() {}
    }
    vi.stubGlobal("FileReader", MockFileReader);
    render(<App />); fireEvent.click(screen.getByRole("button", { name: /scan/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled());
    progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: audioItem({ path: "D:/音乐/a.flac", fileName: "a.flac", wholeTrackStatus: "normal" }) }); progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 2, item: audioItem({ path: "D:/音乐/b.flac", fileName: "b.flac", wholeTrackStatus: "normal" }) });
    fireEvent.click(await screen.findByText("a.flac")); fireEvent.change(screen.getByLabelText(/cover file/i), { target: { files: [new File(["a"], "a.png", { type: "image/png" })] } }); fireEvent.click(screen.getByText("b.flac")); readers[0].onload?.();
    expect(screen.getByText("No cover selected")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/cover file/i), { target: { files: [new File(["bad"], "bad.png", { type: "image/png" })] } }); readers[1].onerror?.();
    expect(await screen.findByText("Unable to read cover image")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/cover file/i), { target: { files: [new File(["good"], "good.png", { type: "image/png" })] } }); readers[2].onload?.();
    await waitFor(() => expect(screen.queryByText("Unable to read cover image")).not.toBeInTheDocument());
    expect(screen.getByText("image/png")).toBeInTheDocument();
  });

  it("aborts cover reads on editor replacement and unmount and ignores retained callbacks", async () => {
    const readers: Array<{ result: ArrayBuffer; onload: null | (() => void); onerror: null | (() => void); abort: ReturnType<typeof vi.fn> }> = [];
    class MockFileReader {
      result = new Uint8Array([1, 2, 3]).buffer; onload: null | (() => void) = null; onerror: null | (() => void) = null; abort = vi.fn();
      constructor() { readers.push(this); }
      readAsArrayBuffer() {}
    }
    vi.stubGlobal("FileReader", MockFileReader);
    const view = render(<App />); fireEvent.click(screen.getByRole("button", { name: /scan/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled()); progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: audioItem({ wholeTrackStatus: "normal" }) }); fireEvent.click(await screen.findByText("track.flac")); fireEvent.change(screen.getByLabelText(/cover file/i), { target: { files: [new File(["a"], "a.png", { type: "image/png" })] } });
    const retainedFirst = readers[0].onload;
    act(() => editorStore.setItem(audioItem({ metadata: { ...audioItem().metadata, common: { title: "Replacement" } }, wholeTrackStatus: "normal" })));
    expect(readers[0].abort).toHaveBeenCalled();
    retainedFirst?.();
    expect(editorStore.getState().draft.cover).toBeUndefined();

    fireEvent.change(screen.getByLabelText(/cover file/i), { target: { files: [new File(["b"], "b.png", { type: "image/png" })] } });
    const retainedSecond = readers[1].onload;
    view.unmount();
    expect(readers[1].abort).toHaveBeenCalled();
    retainedSecond?.();
    expect(editorStore.getState().draft.cover).toBeUndefined();
  });

  it("keeps cover read completion active through StrictMode effect replay", async () => {
    const readers: Array<{ result: ArrayBuffer; onload: null | (() => void); onerror: null | (() => void) }> = [];
    class MockFileReader {
      result = new Uint8Array([4, 5, 6]).buffer; onload: null | (() => void) = null; onerror: null | (() => void) = null;
      constructor() { readers.push(this); }
      readAsArrayBuffer() {}
    }
    vi.stubGlobal("FileReader", MockFileReader);
    render(<StrictMode><App /></StrictMode>);
    fireEvent.click(screen.getByRole("button", { name: /scan/i }));
    await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled());
    progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: audioItem({ wholeTrackStatus: "normal" }) });
    fireEvent.click(await screen.findByText("track.flac"));
    fireEvent.change(screen.getByLabelText(/cover file/i), { target: { files: [new File([new Uint8Array([4, 5, 6])], "replacement.png", { type: "image/png" })] } });

    act(() => readers[0].onload?.());

    expect(editorStore.getState().draft.cover).toEqual({ mimeType: "image/png", data: "BAUG" });
  });

  it("requires details reload for a new search result object with the same provider ID", async () => {
    const summaryResult = { id: "same", source: "musicbrainz" as const, title: "Same", confidence: "high" as const };
    vi.mocked(window.musicId3.searchMetadata).mockResolvedValueOnce([{ ...summaryResult }]).mockResolvedValueOnce([{ ...summaryResult }]);
    vi.mocked(window.musicId3.getMetadataCandidate).mockResolvedValue({ ...summaryResult, cover: { mimeType: "image/jpeg", data: "AQID" } });
    render(<App />); fireEvent.click(screen.getByRole("button", { name: /scan/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled()); progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: audioItem({ wholeTrackStatus: "normal" }) }); fireEvent.click(await screen.findByText("track.flac")); fireEvent.change(screen.getByLabelText(/candidate query/i), { target: { value: "same" } }); fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
    fireEvent.click(await screen.findByRole("button", { name: /load candidate details/i })); await waitFor(() => expect(screen.queryByRole("button", { name: /load candidate details/i })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^search$/i }));
    expect(await screen.findByRole("button", { name: /load candidate details/i })).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox", { name: /cover/i }).at(-1)).toBeDisabled();
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
    expect(screen.queryByRole("button", { name: /confirm candidate write/i })).not.toBeInTheDocument();
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

  it("does not let a stale cover-clear confirmation cancel a replacement read", async () => {
    const originalCover = { mimeType: "image/jpeg", data: "AQID" };
    const readers: Array<{ result: ArrayBuffer; onload: null | (() => void); onerror: null | (() => void); abort: ReturnType<typeof vi.fn> }> = [];
    class MockFileReader {
      result = new Uint8Array([4, 5, 6]).buffer; onload: null | (() => void) = null; onerror: null | (() => void) = null; abort = vi.fn();
      constructor() { readers.push(this); }
      readAsArrayBuffer() {}
    }
    vi.stubGlobal("FileReader", MockFileReader);
    render(<App />); fireEvent.click(screen.getByRole("button", { name: /scan/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled());
    progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: audioItem({ metadata: { ...audioItem().metadata, common: { ...audioItem().metadata.common, cover: originalCover } }, cover: originalCover, wholeTrackStatus: "normal" }) });
    fireEvent.click(await screen.findByText("track.flac"));
    fireEvent.click(screen.getByRole("button", { name: /remove cover/i }));
    const staleClear = screen.getByRole("button", { name: /confirm clear/i });
    fireEvent.change(screen.getByLabelText(/cover file/i), { target: { files: [new File([new Uint8Array([4, 5, 6])], "replacement.png", { type: "image/png" })] } });

    fireEvent.click(staleClear);

    expect(readers[0].abort).not.toHaveBeenCalled();
    expect(editorStore.getState().draft.cover).toEqual(originalCover);
    expect(window.musicId3.writeAudio).not.toHaveBeenCalled();
  });

  it("keeps a completed replacement cover safe from its stale clear confirmation", async () => {
    const originalCover = { mimeType: "image/jpeg", data: "AQID" };
    const replacementCover = { mimeType: "image/png", data: "BAUG" };
    const readers: Array<{ result: ArrayBuffer; onload: null | (() => void); onerror: null | (() => void) }> = [];
    class MockFileReader {
      result = new Uint8Array([4, 5, 6]).buffer; onload: null | (() => void) = null; onerror: null | (() => void) = null;
      constructor() { readers.push(this); }
      readAsArrayBuffer() {}
    }
    vi.stubGlobal("FileReader", MockFileReader);
    render(<App />); fireEvent.click(screen.getByRole("button", { name: /scan/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled());
    progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: audioItem({ metadata: { ...audioItem().metadata, common: { ...audioItem().metadata.common, cover: originalCover } }, cover: originalCover, wholeTrackStatus: "normal" }) });
    fireEvent.click(await screen.findByText("track.flac"));
    fireEvent.change(screen.getByLabelText(/cover file/i), { target: { files: [new File([new Uint8Array([4, 5, 6])], "replacement.png", { type: "image/png" })] } });
    fireEvent.click(screen.getByRole("button", { name: /remove cover/i }));
    const staleClear = screen.getByRole("button", { name: /confirm clear/i });

    staleClear.addEventListener("click", () => readers[0].onload?.(), { capture: true, once: true });
    fireEvent.click(staleClear);

    expect(screen.queryByRole("button", { name: /confirm clear/i })).not.toBeInTheDocument();
    expect(editorStore.getState().draft.cover).toEqual(replacementCover);
    expect(window.musicId3.writeAudio).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /preview diff/i }));
    fireEvent.click(screen.getByRole("button", { name: /write selected fields/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm write/i }));
    await waitFor(() => expect(window.musicId3.writeAudio).toHaveBeenCalledWith("D:/音乐/track.flac", expect.objectContaining({ fields: { cover: replacementCover }, selectedFields: ["cover"] })));
  });

  it("parses raw CUE edits and saves the validated document with selected encoding", async () => {
    render(<App />); const cue: LibraryItem = { kind: "cue", path: "D:/音乐/album.cue", encoding: "gb18030", rawText: 'TITLE "Album"', parsed: { title: "Album", remarks: [], files: [], tracks: [], unknownLines: [] }, referencedFiles: [], missingReferencedFiles: [], candidateEncodings: ["utf8", "gb18030"] }; fireEvent.click(screen.getByRole("button", { name: /scan/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled()); progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: cue }); fireEvent.click(await screen.findByText("album.cue")); fireEvent.click(screen.getByRole("button", { name: /^raw$/i })); fireEvent.change(screen.getByLabelText(/raw cue/i), { target: { value: 'TITLE "Edited"\nFILE "disc.flac" WAVE\n TRACK 01 AUDIO\n  INDEX 01 00:00:00' } }); fireEvent.blur(screen.getByLabelText(/raw cue/i)); await waitFor(() => expect(window.musicId3.previewCue).toHaveBeenCalled()); fireEvent.change(screen.getByLabelText(/encoding/i), { target: { value: "utf8" } }); fireEvent.click(screen.getByRole("button", { name: /save cue/i })); fireEvent.click(await screen.findByRole("button", { name: /confirm cue save/i }));
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
    fireEvent.click(screen.getByRole("button", { name: /save cue/i })); fireEvent.click(await screen.findByRole("button", { name: /confirm cue save/i }));
    await waitFor(() => expect(window.musicId3.saveCue).toHaveBeenCalledWith(expect.objectContaining({ rawText: 'TITLE "Second"', document: expect.objectContaining({ title: "Second" }) })));
  });

  it("mutates structured CUE fields in the saved document", async () => {
    render(<App />); const cue: LibraryItem = { kind: "cue", path: "D:/音乐/album.cue", encoding: "utf8", rawText: 'TITLE "Album"', parsed: { title: "Album", remarks: [], files: [{ path: "old.flac" }], tracks: [{ number: 1, title: "Old track", indexes: [{ number: 1, time: "00:00:00" }] }], unknownLines: [] }, referencedFiles: [], missingReferencedFiles: [] }; fireEvent.click(screen.getByRole("button", { name: /scan/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled()); progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: cue }); fireEvent.click(await screen.findByText("album.cue")); fireEvent.change(screen.getByLabelText(/cue album title/i), { target: { value: "Edited album" } }); fireEvent.change(screen.getByLabelText(/cue file 1/i), { target: { value: "new.flac" } }); fireEvent.change(screen.getByLabelText(/track 1 title/i), { target: { value: "Edited track" } }); fireEvent.click(screen.getByRole("button", { name: /save cue/i })); fireEvent.click(await screen.findByRole("button", { name: /confirm cue save/i }));
    await waitFor(() => expect(window.musicId3.saveCue).toHaveBeenCalledWith(expect.objectContaining({ rawText: "", document: expect.objectContaining({ title: "Edited album", files: [expect.objectContaining({ path: "new.flac" })], tracks: [expect.objectContaining({ title: "Edited track" })] }) })));
  });

  it("opens a MusicBrainz release as a CUE draft for a suspected whole-track", async () => {
    vi.mocked(window.musicId3.searchMetadata).mockResolvedValue([{ id: "release", source: "musicbrainz", title: "Candidate release", artist: "Artist", trackCount: 1, confidence: "low" }]);
    vi.mocked(window.musicId3.getMetadataCandidate).mockResolvedValue({ id: "release", source: "musicbrainz", title: "Candidate release", artist: "Artist", offsets: [150], tracks: [{ number: 1, title: "First" }], confidence: "high", cover: { mimeType: "image/jpeg", data: "AQID" } });
    render(<App />); fireEvent.click(screen.getByRole("button", { name: /scan/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled()); progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: audioItem() }); fireEvent.click(await screen.findByText("track.flac")); fireEvent.change(screen.getByLabelText(/candidate query/i), { target: { value: "release" } }); fireEvent.click(screen.getByRole("button", { name: /^search$/i })); await screen.findByText("Candidate release"); fireEvent.click(screen.getByRole("button", { name: /apply candidate/i }));
    expect(await screen.findByDisplayValue("Candidate release")).toBeInTheDocument(); expect(window.musicId3.getMetadataCandidate).toHaveBeenCalledWith("musicbrainz", "release", expect.objectContaining({ title: "Old title", artist: "Artist", durationMs: 215_000 })); expect(window.musicId3.buildCandidateCue).toHaveBeenCalledWith(expect.objectContaining({ audioPath: "D:/音乐/track.flac", candidate: expect.objectContaining({ offsets: [150] }) })); expect(screen.getByText(/musicbrainz release/i)).toBeInTheDocument(); expect(screen.getByAltText("candidate cover")).toBeInTheDocument();
  });

  it("shows generated CUE provenance and warns before saving a low-confidence inferred candidate", async () => {
    vi.mocked(window.musicId3.searchMetadata).mockResolvedValue([{ id: "release", releaseId: "release", mediumPosition: 2, source: "musicbrainz", title: "Candidate release", artist: "Artist", trackCount: 1, confidence: "low" }]);
    vi.mocked(window.musicId3.getMetadataCandidate).mockResolvedValue({ id: "release", releaseId: "release", source: "musicbrainz", title: "Candidate release", artist: "Artist", discId: "disc-2", offsets: [150], tracks: [{ number: 1, title: "First" }], confidence: "low", evidence: ["Track count matched"] });
    vi.mocked(window.musicId3.buildCandidateCue).mockResolvedValue({ title: "Candidate release", performer: "Artist", remarks: [], files: [{ path: "track.flac", type: "WAVE" }], tracks: [{ number: 1, title: "First", indexes: [{ number: 1, time: "00:00:00" }] }], unknownLines: [], provenance: { source: "musicbrainz", releaseId: "release", discId: "disc-2", confidence: "low", evidence: ["Track count matched"], inferred: true } });
    render(<App />); fireEvent.click(screen.getByRole("button", { name: /scan/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled()); progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: audioItem() }); fireEvent.click(await screen.findByText("track.flac")); fireEvent.change(screen.getByLabelText(/candidate query/i), { target: { value: "Candidate release" } }); fireEvent.click(screen.getByRole("button", { name: /^search$/i })); fireEvent.click(await screen.findByRole("button", { name: /apply candidate/i }));

    expect(await screen.findByText(/release id: release/i)).toBeInTheDocument();
    expect(screen.getByText(/disc id: disc-2/i)).toBeInTheDocument();
    expect(screen.getByText(/track count matched/i)).toBeInTheDocument();
    expect(screen.getByText(/confidence: low/i)).toBeInTheDocument();
    expect(screen.getByText(/inferred candidate/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/encoding/i)).toHaveValue("utf8-bom");
    fireEvent.click(screen.getByRole("button", { name: /save cue/i }));
    expect(await screen.findByText(/review this inferred, low-confidence candidate/i)).toBeInTheDocument();
    expect(screen.queryByText(/saving creates a \.bak/i)).not.toBeInTheDocument();
  });

  it("re-decodes original CUE bytes when an uncertain source encoding is selected", async () => {
    const cue: LibraryItem = { kind: "cue", path: "D:/音乐/旧编码.cue", encoding: "gbk", rawText: 'TITLE "错误预览"', parsed: { title: "错误预览", remarks: [], files: [{ path: "disc.flac" }], tracks: [{ number: 1, indexes: [{ number: 1, time: "00:00:00" }] }], unknownLines: [] }, referencedFiles: [], missingReferencedFiles: [], candidateEncodings: ["gbk", "big5"] };
    vi.mocked(window.musicId3.readCue).mockResolvedValue({ ...cue, encoding: "big5", rawText: 'TITLE "正确预览"', parsed: { ...cue.parsed, title: "正确预览" } });
    render(<StrictMode><App /></StrictMode>); fireEvent.click(screen.getByRole("button", { name: /scan/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled()); progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: cue }); fireEvent.click(await screen.findByText("旧编码.cue"));

    fireEvent.click(screen.getByRole("button", { name: /big5/i }));

    await waitFor(() => expect(window.musicId3.readCue).toHaveBeenCalledWith(cue.path, "big5"));
    expect(screen.getByDisplayValue("正确预览")).toBeInTheDocument();
  });

  it("offers every common metadata field with numeric selection semantics", async () => {
    const item = audioItem({ wholeTrackStatus: "normal", metadata: { ...audioItem().metadata, common: { ...audioItem().metadata.common, trackNumber: 2, trackTotal: 11, discNumber: 1, discTotal: 2, composer: "Composer", lyrics: "Lyrics", copyright: "Copyright" } } });
    render(<App />); fireEvent.click(screen.getByRole("button", { name: /scan/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled()); progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item }); fireEvent.click(await screen.findByText("track.flac"));

    for (const field of ["trackNumber", "trackTotal", "discNumber", "discTotal", "composer", "lyrics", "copyright"]) {
      expect(screen.getByRole("checkbox", { name: field })).toBeInTheDocument();
      expect(screen.getByLabelText(`${field} value`)).toBeInTheDocument();
    }
    fireEvent.change(screen.getByLabelText("trackNumber value"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "trackNumber" }));
    fireEvent.click(screen.getByRole("button", { name: /preview diff/i }));
    fireEvent.click(screen.getByRole("button", { name: /write selected fields/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm write/i }));
    await waitFor(() => expect(window.musicId3.writeAudio).toHaveBeenCalledWith(item.path, expect.objectContaining({ fields: { trackNumber: 3 }, selectedFields: ["trackNumber"] })));
  });

  it("defaults and resets candidate queries from the selected item context", async () => {
    render(<App />); fireEvent.click(screen.getByRole("button", { name: /scan/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled());
    progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: audioItem({ path: "D:/音乐/song.flac", fileName: "song.flac", wholeTrackStatus: "normal", metadata: { common: { artist: "Artist", title: "Song" }, raw: {}, durationMs: 10 } }) });
    progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 2, item: audioItem({ path: "D:/音乐/disc.flac", fileName: "disc.flac", metadata: { common: { artist: "Album Artist", album: "Album" }, raw: {}, durationMs: 901_000 } }) });
    fireEvent.click(await screen.findByText("song.flac"));
    expect(screen.getByLabelText(/candidate query/i)).toHaveValue("Artist Song");
    fireEvent.change(screen.getByLabelText(/candidate query/i), { target: { value: "custom" } });
    fireEvent.click(screen.getByText("disc.flac"));
    expect(screen.getByLabelText(/candidate query/i)).toHaveValue("Album Artist Album");
  });

  it("navigates a recursive directory hierarchy and filters the current library view", async () => {
    render(<App />); fireEvent.click(screen.getByRole("button", { name: /scan/i })); await waitFor(() => expect(window.musicId3.scanDirectory).toHaveBeenCalled());
    progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 1, item: audioItem({ path: "D:/音乐/root.mp3", fileName: "root.mp3", extension: ".mp3", wholeTrackStatus: "normal" }) });
    progressListener?.({ scanId: "scan-1", phase: "scanning", scannedCount: 2, item: audioItem({ path: "D:/音乐/现场/live.flac", fileName: "live.flac", wholeTrackStatus: "normal" }) });
    await screen.findByText("live.flac");

    fireEvent.click(screen.getByRole("button", { name: "现场" }));
    expect(screen.queryByText("root.mp3")).not.toBeInTheDocument();
    expect(screen.getByText("live.flac")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/library search/i), { target: { value: "missing" } });
    expect(screen.queryByText("live.flac")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/library search/i), { target: { value: "live" } });
    fireEvent.change(screen.getByLabelText(/format filter/i), { target: { value: ".flac" } });
    expect(screen.getByText("live.flac")).toBeInTheDocument();
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

  it("keeps Settings async actions active through StrictMode effect replay", async () => {
    render(<StrictMode><App /></StrictMode>);
    fireEvent.click(screen.getByText("Settings"));
    fireEvent.click(screen.getByRole("button", { name: /clear online cache/i }));

    await waitFor(() => expect(window.musicId3.clearOnlineCache).toHaveBeenCalled());
    expect(await screen.findByText("Online cache cleared")).toBeInTheDocument();
  });

  it("does not refresh Settings status after a save resolves following unmount", async () => {
    let resolveSave!: () => void;
    vi.mocked(window.musicId3.setProviderCookie).mockImplementation(() => new Promise<void>((resolve) => { resolveSave = resolve; }));
    const view = render(<App />);
    await waitFor(() => expect(window.musicId3.getProviderCookieStatus).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("Settings"));
    fireEvent.change(screen.getByLabelText(/^cookie$/i), { target: { value: "saved" } });
    fireEvent.click(screen.getByRole("button", { name: /save cookie/i }));
    await waitFor(() => expect(window.musicId3.setProviderCookie).toHaveBeenCalled());
    const statusReadsBeforeUnmount = vi.mocked(window.musicId3.getProviderCookieStatus).mock.calls.length;

    view.unmount();
    await act(async () => {
      resolveSave();
      await Promise.resolve();
    });

    expect(window.musicId3.getProviderCookieStatus).toHaveBeenCalledTimes(statusReadsBeforeUnmount);
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

  it("keeps delayed provider test and save results with their originating provider", async () => {
    let resolveTest!: (value: Awaited<ReturnType<typeof window.musicId3.testProviderCookie>>) => void;
    let resolveSave!: () => void;
    vi.mocked(window.musicId3.testProviderCookie).mockImplementation(() => new Promise((resolve) => { resolveTest = resolve; }));
    vi.mocked(window.musicId3.setProviderCookie).mockImplementation(() => new Promise<void>((resolve) => { resolveSave = resolve; }));
    vi.mocked(window.musicId3.getProviderCookieStatus).mockImplementation(async (provider) => provider === "netease" ? "configured" : "unconfigured");
    render(<App />); fireEvent.click(screen.getByText("Settings")); await waitFor(() => expect(screen.getByLabelText(/cookie status/i)).toHaveTextContent("configured"));
    fireEvent.click(screen.getByRole("button", { name: /^test$/i })); fireEvent.change(screen.getByLabelText(/cookie provider/i), { target: { value: "qq" } }); await waitFor(() => expect(screen.getByLabelText(/cookie status/i)).toHaveTextContent("unconfigured")); resolveTest({ ok: false, error: "NetEase connectivity failed" }); await Promise.resolve();
    expect(screen.queryByText(/netease connectivity failed/i)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/cookie provider/i), { target: { value: "netease" } }); fireEvent.change(screen.getByLabelText(/^cookie$/i), { target: { value: "netease-cookie" } }); fireEvent.click(screen.getByRole("button", { name: /save cookie/i })); fireEvent.change(screen.getByLabelText(/cookie provider/i), { target: { value: "qq" } }); fireEvent.change(screen.getByLabelText(/^cookie$/i), { target: { value: "qq-draft" } }); resolveSave();
    await waitFor(() => expect(screen.getByLabelText(/^cookie$/i)).toHaveValue("qq-draft"));
    expect(screen.getByLabelText(/cookie status/i)).toHaveTextContent("unconfigured");
  });

  it("keeps a completed Cookie save authoritative after switching away and back", async () => {
    let resolveSave!: () => void;
    let resolveStale!: (status: "configured" | "unconfigured") => void;
    vi.mocked(window.musicId3.setProviderCookie).mockImplementation(() => new Promise<void>((resolve) => { resolveSave = resolve; }));
    vi.mocked(window.musicId3.getProviderCookieStatus)
      .mockResolvedValueOnce("unconfigured")
      .mockResolvedValueOnce("unconfigured")
      .mockImplementationOnce(() => new Promise((resolve) => { resolveStale = resolve; }))
      .mockResolvedValueOnce("configured");
    render(<App />); fireEvent.click(screen.getByText("Settings")); await waitFor(() => expect(window.musicId3.getProviderCookieStatus).toHaveBeenCalledTimes(1)); fireEvent.change(screen.getByLabelText(/^cookie$/i), { target: { value: "saved" } }); fireEvent.click(screen.getByRole("button", { name: /save cookie/i })); fireEvent.change(screen.getByLabelText(/cookie provider/i), { target: { value: "qq" } }); await waitFor(() => expect(window.musicId3.getProviderCookieStatus).toHaveBeenCalledTimes(2)); fireEvent.change(screen.getByLabelText(/cookie provider/i), { target: { value: "netease" } }); await waitFor(() => expect(window.musicId3.getProviderCookieStatus).toHaveBeenCalledTimes(3));

    resolveSave();
    await waitFor(() => expect(window.musicId3.getProviderCookieStatus).toHaveBeenCalledTimes(4));
    expect(await screen.findByLabelText(/cookie status/i)).toHaveTextContent("configured");
    resolveStale("unconfigured");
    await Promise.resolve();
    expect(screen.getByLabelText(/cookie status/i)).toHaveTextContent("configured");
  });

  it("keeps a completed Cookie clear authoritative after switching away and back", async () => {
    let resolveClear!: () => void;
    let resolveStale!: (status: "configured" | "unconfigured") => void;
    vi.mocked(window.musicId3.setProviderCookie).mockImplementation(() => new Promise<void>((resolve) => { resolveClear = resolve; }));
    vi.mocked(window.musicId3.getProviderCookieStatus)
      .mockResolvedValueOnce("configured")
      .mockResolvedValueOnce("unconfigured")
      .mockImplementationOnce(() => new Promise((resolve) => { resolveStale = resolve; }))
      .mockResolvedValueOnce("unconfigured");
    render(<App />); fireEvent.click(screen.getByText("Settings")); await waitFor(() => expect(screen.getByLabelText(/cookie status/i)).toHaveTextContent("configured")); fireEvent.click(screen.getByRole("button", { name: /^clear$/i })); fireEvent.change(screen.getByLabelText(/cookie provider/i), { target: { value: "qq" } }); await waitFor(() => expect(window.musicId3.getProviderCookieStatus).toHaveBeenCalledTimes(2)); fireEvent.change(screen.getByLabelText(/cookie provider/i), { target: { value: "netease" } }); await waitFor(() => expect(window.musicId3.getProviderCookieStatus).toHaveBeenCalledTimes(3));

    resolveClear();
    await waitFor(() => expect(window.musicId3.getProviderCookieStatus).toHaveBeenCalledTimes(4));
    expect(await screen.findByLabelText(/cookie status/i)).toHaveTextContent("unconfigured");
    resolveStale("configured");
    await Promise.resolve();
    expect(screen.getByLabelText(/cookie status/i)).toHaveTextContent("unconfigured");
  });

  it("routes Choose folder rejection through the safe library-store error state", async () => {
    vi.mocked(window.musicId3.selectDirectory).mockRejectedValue(new Error("private picker failure"));
    render(<App />); fireEvent.click(screen.getByRole("button", { name: /choose folder/i }));
    expect(await screen.findByText("Unable to select a folder")).toBeInTheDocument();
    expect(screen.queryByText(/private picker failure/i)).not.toBeInTheDocument();
  });
});
