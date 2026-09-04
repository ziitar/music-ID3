import { useSyncExternalStore } from "react";
import type { LibraryItem, ScanProgress } from "../../shared/types";
import type { MusicId3Api } from "../../shared/ipc";

export type LibraryState = { root?: string; items: LibraryItem[]; selectedPath?: string; scanning: boolean; scanId?: string; scannedCount: number; totalCount?: number; error?: string };

function bridge(): MusicId3Api | undefined { return typeof window !== "undefined" ? window.musicId3 : undefined; }

export function createLibraryStore(api?: MusicId3Api) {
  let state: LibraryState = { items: [], scanning: false, scannedCount: 0 };
  let pendingProgress: ScanProgress[] = [];
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  const onProgress = (progress: ScanProgress) => {
    if (!state.scanning) return;
    if (!state.scanId) { pendingProgress.push(progress); return; }
    if (progress.scanId !== state.scanId) return;
    state = { ...state, scanning: progress.phase === "scanning", scannedCount: progress.scannedCount, totalCount: progress.totalCount, error: progress.error, items: progress.item ? [...state.items.filter((item) => item.path !== progress.item!.path), progress.item] : state.items };
    if (progress.phase === "complete" || progress.phase === "error") state = { ...state, scanning: false };
    emit();
  };
  let unsubscribe: (() => void) | undefined;
  const getApi = () => api ?? bridge();
  return {
    getState: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    selectRoot: async (root?: string) => { const currentApi = getApi(); if (state.scanId && state.scanning) await currentApi?.cancelScan(state.scanId); unsubscribe?.(); unsubscribe = currentApi?.onScanProgress(onProgress); const selected = root ?? await currentApi?.selectDirectory(); if (!selected) return; pendingProgress = []; state = { ...state, root: selected, items: [], selectedPath: undefined, scanning: true, scanId: undefined, scannedCount: 0, error: undefined }; emit(); try { const started = await currentApi?.scanDirectory(selected); if (started && state.root === selected && state.scanning) { state = { ...state, scanId: started.scanId }; const buffered = pendingProgress; pendingProgress = []; buffered.forEach(onProgress); } emit(); } catch { pendingProgress = []; state = { ...state, scanning: false, error: "Unable to scan this folder" }; emit(); } },
    appendScanItem: (item: LibraryItem) => { state = { ...state, items: [...state.items.filter((entry) => entry.path !== item.path), item] }; emit(); },
    selectItem: (path?: string) => { state = { ...state, selectedPath: path }; emit(); },
    setWholeTrackOverride: (path: string, enabled = true) => { state = { ...state, items: state.items.map((item) => item.kind === "audio" && item.path === path ? { ...item, wholeTrackStatus: enabled ? "overridden" : "suspected" } : item) }; emit(); },
    cancelScan: async () => { const scanId = state.scanId; pendingProgress = []; state = { ...state, scanning: false, scanId: undefined, error: "Scan cancelled" }; emit(); if (scanId) await getApi()?.cancelScan(scanId); },
    refreshItem: async (path: string) => { const item = state.items.find((entry) => entry.path === path); const currentApi = getApi(); if (item?.kind === "audio" && currentApi) { try { const metadata = await currentApi.readAudio(path); state = { ...state, items: state.items.map((entry) => entry.path === path && entry.kind === "audio" ? { ...entry, metadata, cover: metadata.common.cover, durationMs: metadata.durationMs } : entry), error: undefined }; emit(); return metadata; } catch { state = { ...state, error: "Unable to refresh audio metadata" }; emit(); } } },
    dispose: () => unsubscribe?.(),
  };
}

export const libraryStore = createLibraryStore();
export const selectRoot = (root?: string) => libraryStore.selectRoot(root);
export const appendScanItem = (item: LibraryItem) => libraryStore.appendScanItem(item);
export const selectItem = (path?: string) => libraryStore.selectItem(path);
export const setWholeTrackOverride = (path: string, enabled = true) => libraryStore.setWholeTrackOverride(path, enabled);
export const refreshItem = (path: string) => libraryStore.refreshItem(path);
export function useLibraryStore<T>(selector: (state: LibraryState) => T): T { return selector(useSyncExternalStore(libraryStore.subscribe, libraryStore.getState, libraryStore.getState)); }
