import { describe, expect, it, vi } from "vitest";
import { createLibraryStore } from "../../src/stores/library-store";
import type { MusicId3Api } from "../../shared/ipc";
import type { AudioMetadata, CueDocumentState, LibraryItem, ScanProgress } from "../../shared/types";

function audio(path: string): Extract<LibraryItem, { kind: "audio" }> {
  return { kind: "audio", path, fileName: path.split("/").pop() ?? path, extension: ".flac", sizeBytes: 1, durationMs: 1, metadata: { common: { title: "Original" }, raw: {}, durationMs: 1 }, wholeTrackStatus: "normal" };
}

function cue(path: string, title: string): CueDocumentState {
  return { path, encoding: "utf8", rawText: `TITLE "${title}"`, parsed: { title, remarks: [], files: [], tracks: [], unknownLines: [] }, referencedFiles: [], missingReferencedFiles: [] };
}

it("cancels prior scans and ignores stale or cancelled progress", async () => {
  let listener: (progress: ScanProgress) => void = () => undefined;
  const api = { selectDirectory: vi.fn(), scanDirectory: vi.fn().mockResolvedValueOnce({ ok: true, scanId: "old" }).mockResolvedValueOnce({ ok: true, scanId: "new" }), cancelScan: vi.fn(async () => undefined), onScanProgress: vi.fn((next) => { listener = next; return () => undefined; }) } as unknown as MusicId3Api;
  const store = createLibraryStore(api); await store.selectRoot("D:/old"); await store.selectRoot("D:/new"); listener({ scanId: "old", phase: "scanning", scannedCount: 1, item: { kind: "cue", path: "old.cue", encoding: "utf8", rawText: "", parsed: { remarks: [], files: [], tracks: [], unknownLines: [] }, referencedFiles: [], missingReferencedFiles: [] } });
  expect(api.cancelScan).toHaveBeenCalledWith(vi.mocked(api.scanDirectory).mock.calls[0][1]); expect(store.getState().items).toEqual([]); store.cancelScan(); listener({ scanId: "new", phase: "scanning", scannedCount: 2 }); expect(store.getState().scanning).toBe(false);
});

it("retains progress received before the scan start response", async () => {
  let listener: (progress: ScanProgress) => void = () => undefined;
  let resolveStarted!: (value: { ok: true; scanId: string }) => void;
  const started = new Promise<{ ok: true; scanId: string }>((resolve) => { resolveStarted = resolve; });
  const api = {
    selectDirectory: vi.fn(),
    scanDirectory: vi.fn(() => started),
    cancelScan: vi.fn(async () => undefined),
    onScanProgress: vi.fn((next) => { listener = next; return () => undefined; })
  } as unknown as MusicId3Api;
  const store = createLibraryStore(api);

  const selection = store.selectRoot("D:/music");
  listener({
    scanId: "current",
    phase: "scanning",
    scannedCount: 1,
    item: {
      kind: "cue",
      path: "early.cue",
      encoding: "utf8",
      rawText: "",
      parsed: { remarks: [], files: [], tracks: [], unknownLines: [] },
      referencedFiles: [],
      missingReferencedFiles: []
    }
  });
  resolveStarted({ ok: true, scanId: "current" });
  await selection;

  expect(store.getState()).toMatchObject({
    scanId: "current",
    scannedCount: 1,
    items: [{ path: "early.cue" }]
  });
});

it("cancels a scan by renderer request ID before its start response resolves", async () => {
  let resolveStarted!: (value: { ok: true; requestId: string; scanId: string }) => void;
  const started = new Promise<{ ok: true; requestId: string; scanId: string }>((resolve) => { resolveStarted = resolve; });
  const api = { selectDirectory: vi.fn(), scanDirectory: vi.fn(() => started), cancelScan: vi.fn(async () => undefined), onScanProgress: vi.fn(() => () => undefined) } as unknown as MusicId3Api;
  const store = createLibraryStore(api);

  const selection = store.selectRoot("D:/music");
  const requestId = vi.mocked(api.scanDirectory).mock.calls[0][1];
  await store.cancelScan();
  expect(api.cancelScan).toHaveBeenCalledWith(requestId);
  resolveStarted({ ok: true, requestId, scanId: "main-scan" });
  await selection;
  expect(store.getState().scanning).toBe(false);
});

it("ignores stale start responses and progress for overlapping scans of the same root", async () => {
  let listener: (progress: ScanProgress) => void = () => undefined;
  const starts: Array<(value: { ok: true; requestId: string; scanId: string }) => void> = [];
  const api = { selectDirectory: vi.fn(), scanDirectory: vi.fn(() => new Promise((resolve) => starts.push(resolve))), cancelScan: vi.fn(async () => undefined), onScanProgress: vi.fn((next) => { listener = next; return () => undefined; }) } as unknown as MusicId3Api;
  const store = createLibraryStore(api);

  const first = store.selectRoot("D:/same");
  const firstRequest = vi.mocked(api.scanDirectory).mock.calls[0][1];
  const second = store.selectRoot("D:/same");
  await vi.waitFor(() => expect(api.scanDirectory).toHaveBeenCalledTimes(2));
  const secondRequest = vi.mocked(api.scanDirectory).mock.calls[1][1];
  expect(firstRequest).not.toBe(secondRequest);
  listener({ requestId: firstRequest, scanId: "old", phase: "scanning", scannedCount: 1, item: { kind: "cue", path: "old.cue", encoding: "utf8", rawText: "", parsed: { remarks: [], files: [], tracks: [], unknownLines: [] }, referencedFiles: [], missingReferencedFiles: [] } });
  listener({ requestId: secondRequest, scanId: "new", phase: "scanning", scannedCount: 1, item: { kind: "cue", path: "new.cue", encoding: "utf8", rawText: "", parsed: { remarks: [], files: [], tracks: [], unknownLines: [] }, referencedFiles: [], missingReferencedFiles: [] } });
  starts[0]({ ok: true, requestId: firstRequest, scanId: "old" });
  starts[1]({ ok: true, requestId: secondRequest, scanId: "new" });
  await Promise.all([first, second]);

  expect(store.getState().items.map((item) => item.path)).toEqual(["new.cue"]);
  expect(store.getState()).toMatchObject({ requestId: secondRequest, scanId: "new" });
});

it("reports safe errors when folder selection or cancellation fails", async () => {
  const api = { selectDirectory: vi.fn(async () => { throw new Error("private dialog details"); }), scanDirectory: vi.fn(), cancelScan: vi.fn(async () => { throw new Error("private cancel details"); }), onScanProgress: vi.fn(() => () => undefined) } as unknown as MusicId3Api;
  const store = createLibraryStore(api);
  await store.selectRoot();
  expect(store.getState().error).toBe("Unable to select a folder");

  const pendingApi = { ...api, selectDirectory: vi.fn(), scanDirectory: vi.fn(() => new Promise(() => undefined)) } as unknown as MusicId3Api;
  const pendingStore = createLibraryStore(pendingApi);
  void pendingStore.selectRoot("D:/music");
  await pendingStore.cancelScan();
  expect(pendingStore.getState()).toMatchObject({ scanning: false, error: "Unable to cancel scan" });
});

it("leaves scanning state when folder selection is cancelled after stopping a prior scan", async () => {
  const api = { selectDirectory: vi.fn(async () => undefined), scanDirectory: vi.fn(async (_path: string, requestId: string) => ({ ok: true as const, requestId, scanId: "first" })), cancelScan: vi.fn(async () => undefined), onScanProgress: vi.fn(() => () => undefined) } as unknown as MusicId3Api;
  const store = createLibraryStore(api);
  await store.selectRoot("D:/first");

  await store.selectRoot();

  expect(api.cancelScan).toHaveBeenCalled();
  expect(store.getState()).toMatchObject({ scanning: false, requestId: undefined, scanId: undefined });
});

it("keeps only the latest same-path audio refresh result", async () => {
  let listener: (progress: ScanProgress) => void = () => undefined;
  const reads: Array<ReturnType<typeof deferred<AudioMetadata>>> = [];
  const api = { scanDirectory: vi.fn(async (_root: string, requestId: string) => ({ ok: true as const, requestId, scanId: "scan" })), cancelScan: vi.fn(), onScanProgress: vi.fn((next) => { listener = next; return () => undefined; }), readAudio: vi.fn(() => { const read = deferred<AudioMetadata>(); reads.push(read); return read.promise; }) } as unknown as MusicId3Api;
  const store = createLibraryStore(api);
  await store.selectRoot("D:/music");
  listener({ scanId: "scan", phase: "scanning", scannedCount: 1, item: audio("D:/music/same.flac") });

  const first = store.refreshItem("D:/music/same.flac");
  const second = store.refreshItem("D:/music/same.flac");
  reads[1].resolve({ common: { title: "Newest" }, raw: {}, durationMs: 1 });
  await second;
  reads[0].resolve({ common: { title: "Stale" }, raw: {}, durationMs: 1 });
  await first;

  expect(store.getState().items[0]).toMatchObject({ metadata: { common: { title: "Newest" } } });
});

it("keeps only the latest same-path CUE refresh result", async () => {
  let listener: (progress: ScanProgress) => void = () => undefined;
  const reads: Array<ReturnType<typeof deferred<CueDocumentState>>> = [];
  const api = { scanDirectory: vi.fn(async (_root: string, requestId: string) => ({ ok: true as const, requestId, scanId: "scan" })), cancelScan: vi.fn(), onScanProgress: vi.fn((next) => { listener = next; return () => undefined; }), readCue: vi.fn(() => { const read = deferred<CueDocumentState>(); reads.push(read); return read.promise; }) } as unknown as MusicId3Api;
  const store = createLibraryStore(api);
  await store.selectRoot("D:/music");
  listener({ scanId: "scan", phase: "scanning", scannedCount: 1, item: { kind: "cue", ...cue("D:/music/same.cue", "Original") } });

  const first = store.refreshCue("D:/music/same.cue");
  const second = store.refreshCue("D:/music/same.cue");
  reads[1].resolve(cue("D:/music/same.cue", "Newest"));
  await second;
  reads[0].resolve(cue("D:/music/same.cue", "Stale"));
  await first;

  expect(store.getState().items[0]).toMatchObject({ parsed: { title: "Newest" } });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}
