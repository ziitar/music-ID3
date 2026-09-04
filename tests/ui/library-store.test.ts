import { describe, expect, it, vi } from "vitest";
import { createLibraryStore } from "../../src/stores/library-store";
import type { MusicId3Api } from "../../shared/ipc";
import type { ScanProgress } from "../../shared/types";

it("cancels prior scans and ignores stale or cancelled progress", async () => {
  let listener: (progress: ScanProgress) => void = () => undefined;
  const api = { selectDirectory: vi.fn(), scanDirectory: vi.fn().mockResolvedValueOnce({ ok: true, scanId: "old" }).mockResolvedValueOnce({ ok: true, scanId: "new" }), cancelScan: vi.fn(async () => undefined), onScanProgress: vi.fn((next) => { listener = next; return () => undefined; }) } as unknown as MusicId3Api;
  const store = createLibraryStore(api); await store.selectRoot("D:/old"); await store.selectRoot("D:/new"); listener({ scanId: "old", phase: "scanning", scannedCount: 1, item: { kind: "cue", path: "old.cue", encoding: "utf8", rawText: "", parsed: { remarks: [], files: [], tracks: [], unknownLines: [] }, referencedFiles: [], missingReferencedFiles: [] } });
  expect(api.cancelScan).toHaveBeenCalledWith("old"); expect(store.getState().items).toEqual([]); store.cancelScan(); listener({ scanId: "new", phase: "scanning", scannedCount: 2 }); expect(store.getState().scanning).toBe(false);
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
