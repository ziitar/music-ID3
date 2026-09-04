import { useSyncExternalStore } from "react";
import type { AudioMetadata, CueDocument, LibraryItem, MetadataCandidate, MetadataPatch, MetadataSource, SaveCueInput, SaveCueResult, WriteResult } from "../../shared/types";
import type { MusicId3Api } from "../../shared/ipc";

export type DiffEntry = { field: string; oldValue: unknown; newValue: unknown };
export type EditorState = { generation: number; item?: LibraryItem; draft: Record<string, unknown>; selectedFields: string[]; diff: DiffEntry[]; candidates: MetadataCandidate[]; searching: boolean; searchCompleted: boolean; cueDraft?: CueDocument; candidateSource?: string; error?: string };
export type EditorOwnership = { path: string; generation: number };
export type AudioWriteConfirmation = EditorOwnership & { selectedFields: string[]; fields: Record<string, unknown>; diff: DiffEntry[] };
export type AudioWriteOutcome = WriteResult & { path: string; operation: number; latest: boolean };
export type CueSaveOutcome = SaveCueResult & { path: string; operation: number; latest: boolean };

function api(): MusicId3Api | undefined { return typeof window !== "undefined" ? window.musicId3 : undefined; }
function equalValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => equalValue(value, right[index]));
  if (left && right && typeof left === "object" && typeof right === "object") {
    const a = left as Record<string, unknown>; const b = right as Record<string, unknown>; const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && equalValue(a[key], b[key]));
  }
  return false;
}

export function createEditorStore(bridge?: MusicId3Api) {
  let state: EditorState = { generation: 0, draft: {}, selectedFields: [], diff: [], candidates: [], searching: false, searchCompleted: false };
  let candidateGeneration = 0;
  let editorGeneration = 0;
  const writeGenerations = new Map<string, number>();
  const writeQueues = new Map<string, Promise<void>>();
  const cueSaveGenerations = new Map<string, number>();
  const cueSaveQueues = new Map<string, Promise<void>>();
  const listeners = new Set<() => void>(); const emit = () => listeners.forEach((listener) => listener());
  const captureOwnership = (): EditorOwnership | undefined => state.item ? { path: state.item.path, generation: editorGeneration } : undefined;
  const isCurrentOwnership = (ownership: EditorOwnership) => editorGeneration === ownership.generation && state.item?.path === ownership.path;
  const captureAudioWriteConfirmation = (): AudioWriteConfirmation | undefined => state.item?.kind === "audio" ? {
    path: state.item.path, generation: editorGeneration, selectedFields: [...state.selectedFields],
    fields: Object.fromEntries(state.selectedFields.map((field) => [field, state.draft[field]])), diff: state.diff.map((entry) => ({ ...entry }))
  } : undefined;
  const isAudioWriteConfirmationCurrent = (confirmation: AudioWriteConfirmation) => {
    if (!isCurrentOwnership(confirmation) || state.item?.kind !== "audio") return false;
    const currentFields = Object.fromEntries(state.selectedFields.map((field) => [field, state.draft[field]]));
    return equalValue(confirmation.selectedFields, state.selectedFields) && equalValue(confirmation.fields, currentFields) && equalValue(confirmation.diff, state.diff);
  };
  return {
    getState: () => state,
    getGeneration: () => editorGeneration,
    captureOwnership,
    isCurrentOwnership,
    isCurrentItem: (path: string, generation: number) => editorGeneration === generation && state.item?.path === path,
    captureAudioWriteConfirmation,
    isAudioWriteConfirmationCurrent,
    isLatestAudioWrite: (path: string, operation: number) => writeGenerations.get(path) === operation,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    setItem: (item?: LibraryItem) => { candidateGeneration += 1; editorGeneration += 1; const common = item?.kind === "audio" ? item.metadata.common : {}; state = { generation: editorGeneration, item, draft: { ...common }, selectedFields: [], diff: [], candidates: [], searching: false, searchCompleted: false, error: undefined }; emit(); },
    setField: (field: string, value: unknown) => { state = { ...state, draft: { ...state.draft, [field]: value } }; emit(); },
    setError: (error?: string) => { state = { ...state, error }; emit(); },
    setFieldSelected: (field: string, selected: boolean) => { state = { ...state, selectedFields: selected ? [...new Set([...state.selectedFields, field])] : state.selectedFields.filter((entry) => entry !== field) }; emit(); },
    previewDiff: () => { const oldValues = state.item?.kind === "audio" ? state.item.metadata.common : {}; const diff = state.selectedFields.map((field) => ({ field, oldValue: oldValues[field as keyof typeof oldValues], newValue: state.draft[field] })); state = { ...state, diff }; emit(); return diff; },
    loadCandidateDetails: async (candidate: MetadataCandidate) => { const currentApi = bridge ?? api(); const currentItem = state.item; if (!currentItem || !currentApi) return; const generation = ++candidateGeneration; const targetPath = currentItem.path; try { const resolved = await currentApi.getMetadataCandidate(candidate.source, candidate.id); if (generation !== candidateGeneration || state.item?.path !== targetPath) return; state = { ...state, candidates: state.candidates.map((entry) => entry.source === candidate.source && entry.id === candidate.id ? resolved : entry), error: undefined }; emit(); return resolved; } catch { if (generation !== candidateGeneration || state.item?.path !== targetPath) return; state = { ...state, error: "Unable to load candidate details" }; emit(); } },
    applyCandidate: async (candidate: MetadataCandidate, selectedFields: string[], detailsLoaded = false) => { const currentApi = bridge ?? api(); const currentItem = state.item; if (!currentItem || !currentApi) return; const generation = ++candidateGeneration; const targetPath = currentItem.path; const targetKind = currentItem.kind; const isCurrent = () => generation === candidateGeneration && state.item?.path === targetPath && state.item.kind === targetKind; let resolved: MetadataCandidate; if (detailsLoaded) resolved = candidate; else try { resolved = await currentApi.getMetadataCandidate(candidate.source, candidate.id); if (!isCurrent()) return; state = { ...state, candidates: state.candidates.map((entry) => entry.source === candidate.source && entry.id === candidate.id ? resolved : entry), error: undefined }; emit(); } catch { if (!isCurrent()) return; state = { ...state, error: "Unable to load candidate details" }; emit(); return; } if ((currentItem.kind === "cue" || currentItem.wholeTrackStatus === "suspected") && resolved.source === "musicbrainz") { const audioPath = currentItem.kind === "audio" ? currentItem.path : currentItem.referencedFiles[0]; if (!audioPath) { state = { ...state, error: "CUE candidate needs a referenced audio file" }; emit(); return; } try { const cueDraft = await currentApi.buildCandidateCue({ audioPath, candidate: resolved }); if (!isCurrent()) return; state = { ...state, cueDraft, candidateSource: `${resolved.source} release`, error: undefined }; emit(); return { candidate: resolved, cueDraft }; } catch { if (!isCurrent()) return; state = { ...state, error: "Unable to build candidate CUE" }; emit(); return; } } if (!isCurrent()) return; const applicableFields = selectedFields.filter((field) => field === "title" || resolved[field as keyof MetadataCandidate] !== undefined); if (applicableFields.length === 0) { state = { ...state, selectedFields: [], diff: [], error: "No applicable candidate fields selected" }; emit(); return; } const fieldValues: Record<string, unknown> = { title: resolved.title, artist: resolved.artist, album: resolved.album, date: resolved.date, cover: resolved.cover }; const draft = { ...state.draft }; for (const field of applicableFields) draft[field] = fieldValues[field]; state = { ...state, draft, selectedFields: applicableFields, diff: applicableFields.map((field) => ({ field, oldValue: currentItem.kind === "audio" ? currentItem.metadata.common[field as keyof AudioMetadata["common"]] : undefined, newValue: draft[field] })), error: undefined }; emit(); return { candidate: resolved }; },
    confirmAudioWrite: async (expected?: AudioWriteConfirmation): Promise<AudioWriteOutcome | undefined> => {
      const currentApi = bridge ?? api(); const confirmation = expected ?? captureAudioWriteConfirmation();
      if (!currentApi || !confirmation || !isAudioWriteConfirmationCurrent(confirmation)) return;
      const currentItem = state.item as Extract<LibraryItem, { kind: "audio" }>;
      const operation = (writeGenerations.get(confirmation.path) ?? 0) + 1; writeGenerations.set(confirmation.path, operation);
      const patch = { fields: confirmation.fields, selectedFields: confirmation.selectedFields as (keyof AudioMetadata["common"])[] } as MetadataPatch;
      const prior = writeQueues.get(confirmation.path);
      const write = prior ? prior.catch(() => undefined).then(() => currentApi.writeAudio(confirmation.path, patch)) : currentApi.writeAudio(confirmation.path, patch);
      const queued = write.then(() => undefined, () => undefined); writeQueues.set(confirmation.path, queued);
      try {
        const result = await write; const latest = writeGenerations.get(confirmation.path) === operation;
        if (latest && isCurrentOwnership(confirmation)) { if (!result.ok) state = { ...state, error: result.error }; else state = { ...state, item: { ...currentItem, metadata: result.metadata, cover: result.metadata.common.cover }, error: undefined }; emit(); }
        return { ...result, path: confirmation.path, operation, latest };
      } catch { if (writeGenerations.get(confirmation.path) === operation && isCurrentOwnership(confirmation)) { state = { ...state, error: "Unable to write audio metadata" }; emit(); } }
      finally { if (writeQueues.get(confirmation.path) === queued) writeQueues.delete(confirmation.path); }
    },
    saveCueDraft: async (input: SaveCueInput, expected?: EditorOwnership): Promise<CueSaveOutcome | undefined> => {
      const currentApi = bridge ?? api(); const ownership = expected ?? captureOwnership();
      if (!currentApi || !ownership || !isCurrentOwnership(ownership)) return;
      const operation = (cueSaveGenerations.get(input.path) ?? 0) + 1; cueSaveGenerations.set(input.path, operation);
      const prior = cueSaveQueues.get(input.path);
      const save = prior ? prior.catch(() => undefined).then(() => currentApi.saveCue(input)) : currentApi.saveCue(input);
      const queued = save.then(() => undefined, () => undefined); cueSaveQueues.set(input.path, queued);
      try {
        const result = await save; const latest = cueSaveGenerations.get(input.path) === operation;
        if (latest && isCurrentOwnership(ownership)) { if (!result.ok) state = { ...state, error: result.error }; else state = { ...state, error: undefined }; emit(); }
        return { ...result, path: input.path, operation, latest };
      } catch { if (cueSaveGenerations.get(input.path) === operation && isCurrentOwnership(ownership)) { state = { ...state, error: "Unable to save CUE" }; emit(); } }
      finally { if (cueSaveQueues.get(input.path) === queued) cueSaveQueues.delete(input.path); }
    },
    searchCandidates: async (source: MetadataSource, query: string) => { const currentApi = bridge ?? api(); const generation = ++candidateGeneration; const targetPath = state.item?.path; state = { ...state, searching: true, searchCompleted: false, error: undefined }; emit(); const isCurrent = () => generation === candidateGeneration && state.item?.path === targetPath; try { const candidates = await currentApi?.searchMetadata(source, query) ?? []; if (!isCurrent()) return []; state = { ...state, candidates, searching: false, searchCompleted: true }; emit(); return candidates; } catch { if (!isCurrent()) return []; state = { ...state, searching: false, searchCompleted: true, error: "Metadata search failed" }; emit(); return []; } }
  };
}
export const editorStore = createEditorStore();
export const setFieldSelected = (field: string, selected: boolean) => editorStore.setFieldSelected(field, selected);
export const previewDiff = () => editorStore.previewDiff();
export const confirmAudioWrite = () => editorStore.confirmAudioWrite();
export const saveCueDraft = (input: SaveCueInput) => editorStore.saveCueDraft(input);
export const searchCandidates = (source: MetadataSource, query: string) => editorStore.searchCandidates(source, query);
export function useEditorStore<T>(selector: (state: EditorState) => T): T { return selector(useSyncExternalStore(editorStore.subscribe, editorStore.getState, editorStore.getState)); }
