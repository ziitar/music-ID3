import { useSyncExternalStore } from "react";
import type { AudioMetadata, LibraryItem, ScanProgress } from "../../shared/types";
import type { MusicId3Api } from "../../shared/ipc";

export type LibraryState = { root?: string; currentDirectory?: string; items: LibraryItem[]; selectedPath?: string; organizeSelection: string[]; scanning: boolean; requestId?: string; scanId?: string; scannedCount: number; totalCount?: number; error?: string };
export type NewCueExpectation = { originatingAudioPath: string; isCurrent: () => boolean };

function bridge(): MusicId3Api | undefined { return typeof window !== "undefined" ? window.musicId3 : undefined; }

export function createLibraryStore(api?: MusicId3Api) {
  let state: LibraryState = { items: [], organizeSelection: [], scanning: false, scannedCount: 0 };
  let pendingProgress: ScanProgress[] = [];
  let scanGeneration = 0;
  let requestSequence = 0;
  const itemRefreshGenerations = new Map<string, number>();
  const cueRefreshGenerations = new Map<string, number>();
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  const onProgress = (progress: ScanProgress) => {
    if (!state.scanning) return;
    if (progress.requestId && progress.requestId !== state.requestId) return;
    if (!progress.requestId && !state.scanId) { pendingProgress.push(progress); return; }
    if (!progress.requestId && progress.scanId !== state.scanId) return;
    state = { ...state, scanning: progress.phase === "scanning", scannedCount: progress.scannedCount, totalCount: progress.totalCount, error: progress.error, items: progress.item ? [...state.items.filter((item) => item.path !== progress.item!.path), progress.item] : state.items };
    if (progress.phase === "complete" || progress.phase === "error") state = { ...state, scanning: false };
    emit();
  };
  let unsubscribe: (() => void) | undefined;
  const getApi = () => api ?? bridge();
  return {
    getState: () => state,
    getGeneration: () => scanGeneration,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    selectRoot: async (root?: string) => { const currentApi = getApi(); const generation = ++scanGeneration; const priorRequestId = state.scanning ? state.requestId : undefined; if (priorRequestId) { try { await currentApi?.cancelScan(priorRequestId); } catch { if (generation === scanGeneration) { state = { ...state, error: "Unable to cancel previous scan" }; emit(); } } } unsubscribe?.(); unsubscribe = currentApi?.onScanProgress(onProgress); let selected: string | undefined; try { selected = root ?? await currentApi?.selectDirectory(); } catch { if (generation === scanGeneration) { state = { ...state, scanning: false, requestId: undefined, scanId: undefined, error: "Unable to select a folder" }; emit(); } return; } if (generation !== scanGeneration) return; if (!selected) { state = { ...state, scanning: false, requestId: undefined, scanId: undefined }; emit(); return; } const requestId = `scan-request-${Date.now()}-${++requestSequence}`; pendingProgress = []; state = { ...state, root: selected, currentDirectory: undefined, items: [], selectedPath: undefined, organizeSelection: [], scanning: true, requestId, scanId: undefined, scannedCount: 0, error: undefined }; emit(); try { const started = await currentApi?.scanDirectory(selected, requestId); if (started && generation === scanGeneration && state.requestId === requestId && state.scanning) { state = { ...state, scanId: started.scanId }; const buffered = pendingProgress; pendingProgress = []; buffered.forEach(onProgress); } emit(); } catch { if (generation !== scanGeneration) return; pendingProgress = []; state = { ...state, scanning: false, requestId: undefined, scanId: undefined, error: "Unable to scan this folder" }; emit(); } },
    appendScanItem: (item: LibraryItem) => { state = { ...state, items: [...state.items.filter((entry) => entry.path !== item.path), item] }; emit(); },
    selectItem: (path?: string) => { state = { ...state, selectedPath: path }; emit(); },
    toggleOrganizeSelection: (path: string, selected: boolean) => { state = { ...state, organizeSelection: selected ? [...new Set([...state.organizeSelection, path])] : state.organizeSelection.filter((entry) => entry !== path) }; emit(); },
    setOrganizeSelection: (paths: string[]) => { state = { ...state, organizeSelection: [...new Set(paths)] }; emit(); },
    applyOrganizeMoves: (moves: Array<{ sourcePath: string; destinationPath: string }>) => {
      const normalized = (value: string) => value.replaceAll("\\", "/").toLocaleLowerCase();
      const moveBySource = new Map(moves.map((move) => [normalized(move.sourcePath), move.destinationPath]));
      const root = state.root ? normalized(state.root).replace(/\/$/, "") : undefined;
      const items = state.items.flatMap((item) => {
        const destinationPath = moveBySource.get(normalized(item.path));
        if (!destinationPath) return [item];
        const insideRoot = Boolean(root && (normalized(destinationPath) === root || normalized(destinationPath).startsWith(`${root}/`)));
        if (!insideRoot) return [];
        return [{ ...item, path: destinationPath, ...(item.kind === "audio" ? { fileName: destinationPath.split(/[\\/]/).pop() ?? item.fileName } : {}) } as LibraryItem];
      });
      const movedSelection = state.selectedPath ? moveBySource.get(normalized(state.selectedPath)) : undefined;
      const selectedPath = movedSelection && root && normalized(movedSelection).startsWith(`${root}/`) ? movedSelection : movedSelection ? undefined : state.selectedPath;
      state = { ...state, items, selectedPath, organizeSelection: [], error: undefined };
      emit();
    },
    setCurrentDirectory: (directory?: string) => { state = { ...state, currentDirectory: directory, selectedPath: undefined }; emit(); },
    setWholeTrackOverride: async (path: string, enabled = true) => {
      const currentApi = getApi();
      const generation = scanGeneration;
      const item = state.items.find((entry) => entry.kind === "audio" && entry.path === path);
      if (!currentApi || item?.kind !== "audio" || (enabled && item.wholeTrackStatus !== "suspected")) return false;
      try {
        await currentApi.setWholeTrackOverride(path, enabled);
        if (generation !== scanGeneration || !state.items.some((entry) => entry.kind === "audio" && entry.path === path)) return false;
        state = { ...state, items: state.items.map((entry) => entry.kind === "audio" && entry.path === path ? { ...entry, wholeTrackStatus: enabled ? "overridden" : "suspected" } : entry), error: undefined };
        emit();
        return true;
      } catch {
        if (generation === scanGeneration) { state = { ...state, error: "Unable to change whole-track editing mode" }; emit(); }
        return false;
      }
    },
    updateAudioMetadata: (path: string, metadata: AudioMetadata, expectedGeneration = scanGeneration) => { if (expectedGeneration !== scanGeneration || !state.items.some((entry) => entry.path === path && entry.kind === "audio")) return false; state = { ...state, items: state.items.map((entry) => entry.path === path && entry.kind === "audio" ? { ...entry, metadata, cover: metadata.common.cover, durationMs: metadata.durationMs } : entry) }; emit(); return true; },
    cancelScan: async () => { const requestId = state.requestId; scanGeneration += 1; pendingProgress = []; state = { ...state, scanning: false, requestId: undefined, scanId: undefined, error: "Scan cancelled" }; emit(); if (!requestId) return; try { await getApi()?.cancelScan(requestId); } catch { state = { ...state, error: "Unable to cancel scan" }; emit(); } },
    refreshItem: async (path: string, expectedGeneration = scanGeneration, isExpected: () => boolean = () => true) => {
      const item = state.items.find((entry) => entry.path === path); const currentApi = getApi();
      if (item?.kind !== "audio" || !currentApi || expectedGeneration !== scanGeneration || !isExpected()) return;
      const request = (itemRefreshGenerations.get(path) ?? 0) + 1; itemRefreshGenerations.set(path, request);
      const isCurrent = () => request === itemRefreshGenerations.get(path) && expectedGeneration === scanGeneration && isExpected() && state.items.some((entry) => entry.path === path && entry.kind === "audio");
      try { const metadata = await currentApi.readAudio(path); if (!isCurrent()) return; state = { ...state, items: state.items.map((entry) => entry.path === path && entry.kind === "audio" ? { ...entry, metadata, cover: metadata.common.cover, durationMs: metadata.durationMs } : entry), error: undefined }; emit(); return metadata; }
      catch { if (!isCurrent()) return; state = { ...state, error: "Unable to refresh audio metadata" }; emit(); }
    },
    refreshCue: async (path: string, expectedGeneration = scanGeneration, expectedNewCue?: NewCueExpectation) => {
      const currentApi = getApi();
      const hasExistingCue = () => state.items.some((entry) => entry.path === path && entry.kind === "cue");
      const hasExpectedOrigin = () => Boolean(expectedNewCue && path === `${expectedNewCue.originatingAudioPath}.cue` && expectedNewCue.isCurrent() && state.items.some((entry) => entry.path === expectedNewCue.originatingAudioPath && entry.kind === "audio"));
      const canRefresh = () => expectedGeneration === scanGeneration && (hasExistingCue() || hasExpectedOrigin());
      if (!currentApi || !canRefresh()) return;
      const request = (cueRefreshGenerations.get(path) ?? 0) + 1; cueRefreshGenerations.set(path, request);
      const isCurrent = () => request === cueRefreshGenerations.get(path) && canRefresh();
      try {
        const refreshed = await currentApi.readCue(path); if (!refreshed) throw new Error("No CUE state returned"); if (!isCurrent()) return;
        const item: Extract<LibraryItem, { kind: "cue" }> = { kind: "cue", ...refreshed };
        state = { ...state, items: hasExistingCue() ? state.items.map((entry) => entry.path === path ? item : entry) : [...state.items, item], error: undefined };
        emit(); return item;
      } catch { if (!isCurrent()) return; state = { ...state, error: "Unable to refresh CUE" }; emit(); }
    },
    dispose: () => unsubscribe?.(),
  };
}

export const libraryStore = createLibraryStore();
export const selectRoot = (root?: string) => libraryStore.selectRoot(root);
export const appendScanItem = (item: LibraryItem) => libraryStore.appendScanItem(item);
export const selectItem = (path?: string) => libraryStore.selectItem(path);
export const setCurrentDirectory = (directory?: string) => libraryStore.setCurrentDirectory(directory);
export const setWholeTrackOverride = (path: string, enabled = true) => libraryStore.setWholeTrackOverride(path, enabled);
export const refreshItem = (path: string) => libraryStore.refreshItem(path);
export const refreshCue = (path: string) => libraryStore.refreshCue(path);
export function useLibraryStore<T>(selector: (state: LibraryState) => T): T { return selector(useSyncExternalStore(libraryStore.subscribe, libraryStore.getState, libraryStore.getState)); }
