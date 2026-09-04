import { useSyncExternalStore } from "react";
import type { AudioMetadata, CueDocumentState, LibraryItem, MetadataCandidate, MetadataPatch, MetadataSource, SaveCueInput } from "../../shared/types";
import type { MusicId3Api } from "../../shared/ipc";

export type DiffEntry = { field: string; oldValue: unknown; newValue: unknown };
export type EditorState = { item?: LibraryItem; draft: Record<string, unknown>; selectedFields: string[]; diff: DiffEntry[]; candidates: MetadataCandidate[]; searching: boolean; error?: string };
function api(): MusicId3Api | undefined { return typeof window !== "undefined" ? window.musicId3 : undefined; }
export function createEditorStore(bridge?: MusicId3Api) {
  let state: EditorState = { draft: {}, selectedFields: [], diff: [], candidates: [], searching: false };
  const listeners = new Set<() => void>(); const emit = () => listeners.forEach((listener) => listener());
  return {
    getState: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    setItem: (item?: LibraryItem) => { const common = item?.kind === "audio" ? item.metadata.common : {}; state = { ...state, item, draft: { ...common }, selectedFields: [], diff: [], error: undefined }; emit(); },
    setField: (field: string, value: unknown) => { state = { ...state, draft: { ...state.draft, [field]: value } }; emit(); },
    setFieldSelected: (field: string, selected: boolean) => { state = { ...state, selectedFields: selected ? [...new Set([...state.selectedFields, field])] : state.selectedFields.filter((entry) => entry !== field) }; emit(); },
    previewDiff: () => { const oldValues = state.item?.kind === "audio" ? state.item.metadata.common : {}; const diff = state.selectedFields.map((field) => ({ field, oldValue: oldValues[field as keyof typeof oldValues], newValue: state.draft[field] })); state = { ...state, diff }; emit(); return diff; },
    confirmAudioWrite: async () => { const currentApi = bridge ?? api(); if (state.item?.kind !== "audio" || !currentApi) return; const fields = Object.fromEntries(state.selectedFields.map((field) => [field, state.draft[field]])); const result = await currentApi.writeAudio(state.item.path, { fields, selectedFields: state.selectedFields as (keyof AudioMetadata["common"])[] } as MetadataPatch); if (!result.ok) state = { ...state, error: result.error }; emit(); return result; },
    saveCueDraft: async (input: SaveCueInput) => (bridge ?? api())?.saveCue(input),
    searchCandidates: async (source: MetadataSource, query: string) => { state = { ...state, searching: true, error: undefined }; emit(); try { const candidates = await (bridge ?? api())?.searchMetadata(source, query) ?? []; state = { ...state, candidates, searching: false }; emit(); return candidates; } catch (error) { state = { ...state, searching: false, error: error instanceof Error ? error.message : String(error) }; emit(); return []; } }
  };
}
export const editorStore = createEditorStore();
export const setFieldSelected = (field: string, selected: boolean) => editorStore.setFieldSelected(field, selected);
export const previewDiff = () => editorStore.previewDiff();
export const confirmAudioWrite = () => editorStore.confirmAudioWrite();
export const saveCueDraft = (input: SaveCueInput) => editorStore.saveCueDraft(input);
export const searchCandidates = (source: MetadataSource, query: string) => editorStore.searchCandidates(source, query);
export function useEditorStore<T>(selector: (state: EditorState) => T): T { return selector(useSyncExternalStore(editorStore.subscribe, editorStore.getState, editorStore.getState)); }
