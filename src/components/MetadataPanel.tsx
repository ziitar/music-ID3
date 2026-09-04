import { useEffect, useRef, useState } from "react";
import { editorStore, useEditorStore, type AudioWriteConfirmation, type EditorOwnership } from "../stores/editor-store";
import { libraryStore } from "../stores/library-store";
import type { CoverArt } from "../../shared/types";
import { CueEditor } from "./CueEditor";
import { MetadataCandidates } from "./MetadataCandidates";

type PendingWrite = { confirmation: AudioWriteConfirmation; libraryGeneration: number };
type CoverClearConfirmation = {
  readonly ownership: EditorOwnership;
  readonly cover: CoverArt | undefined;
  readonly coverOperation: number;
};

function valueText(value: unknown): string {
  if (value && typeof value === "object" && "mimeType" in value) return (value as CoverArt).mimeType;
  return String(value ?? "");
}

export function MetadataPanel() {
  const state = useEditorStore((value) => value);
  const { item, draft, selectedFields, diff, cueDraft, error } = state;
  const [confirm, setConfirm] = useState<PendingWrite>();
  const [mode, setMode] = useState<"common" | "raw">("common");
  const [coverConfirm, setCoverConfirm] = useState<CoverClearConfirmation>();
  const coverOperation = useRef(0);
  const activeReader = useRef<FileReader | undefined>(undefined);
  const mounted = useRef(true);
  const abortCoverRead = () => {
    coverOperation.current += 1;
    const reader = activeReader.current;
    activeReader.current = undefined;
    if (!reader) return;
    reader.onload = null;
    reader.onerror = null;
    try { reader.abort(); } catch { /* The read may already have completed. */ }
  };

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; abortCoverRead(); };
  }, []);
  useEffect(() => {
    abortCoverRead();
    setConfirm(undefined);
    setCoverConfirm(undefined);
  }, [state.generation]);

  if (!item) return <aside className="pane details-pane" aria-label="Details"><h2>Details</h2><p className="empty-state">Select a file to inspect.</p></aside>;
  const candidateCueItem = cueDraft ? { kind: "cue" as const, path: item.kind === "cue" ? item.path : `${item.path}.cue`, encoding: item.kind === "cue" ? item.encoding : "utf8" as const, rawText: "", parsed: cueDraft, referencedFiles: item.kind === "cue" ? item.referencedFiles : [item.path], missingReferencedFiles: [] } : undefined;
  if (item.kind === "cue") return <aside className="pane details-pane" aria-label="Details"><CueEditor key={`${item.path}:${candidateCueItem ? "candidate" : "local"}`} item={candidateCueItem ?? item} source={candidateCueItem ? state.candidateSource : undefined} /><MetadataCandidates /></aside>;

  const fields = ["title", "artist", "album", "albumArtist", "date", "genre", "comment"];
  const suspected = item.wholeTrackStatus === "suspected";
  const unsupported = item.extension === ".wv";
  const currentCover = draft.cover as CoverArt | undefined;
  const selectCover = (cover: CoverArt | undefined) => { editorStore.setField("cover", cover); editorStore.setFieldSelected("cover", true); };
  const sameCover = (left: CoverArt | undefined, right: CoverArt | undefined) => left?.mimeType === right?.mimeType && left?.data === right?.data;
  const isCoverConfirmationCurrent = (target: CoverClearConfirmation) => target.coverOperation === coverOperation.current && editorStore.isCurrentOwnership(target.ownership) && sameCover(target.cover, editorStore.getState().draft.cover as CoverArt | undefined);
  const openCoverConfirmation = () => {
    const ownership = editorStore.captureOwnership();
    if (!ownership) return;
    const cover = editorStore.getState().draft.cover as CoverArt | undefined;
    setCoverConfirm({ ownership, cover: cover ? { ...cover } : undefined, coverOperation: coverOperation.current });
  };
  const readCover = (file?: File) => {
    if (!file) return;
    setCoverConfirm(undefined);
    abortCoverRead();
    const operation = ++coverOperation.current;
    const targetPath = item.path;
    const editorGeneration = editorStore.getGeneration();
    const isCurrent = () => mounted.current && operation === coverOperation.current && editorStore.isCurrentItem(targetPath, editorGeneration);
    const reader = new FileReader();
    activeReader.current = reader;
    reader.onerror = () => { if (activeReader.current === reader) activeReader.current = undefined; if (isCurrent()) editorStore.setError("Unable to read cover image"); };
    reader.onload = () => {
      if (activeReader.current === reader) activeReader.current = undefined;
      if (!isCurrent()) return;
      const bytes = new Uint8Array(reader.result as ArrayBuffer); let binary = "";
      bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
      editorStore.setError(undefined);
      selectCover({ mimeType: file.type || "application/octet-stream", data: btoa(binary) });
    };
    reader.readAsArrayBuffer(file);
  };
  const write = async (pending: PendingWrite) => {
    const result = await editorStore.confirmAudioWrite(pending.confirmation);
    if (!result?.ok || !result.latest) return;
    libraryStore.updateAudioMetadata(result.path, result.metadata, pending.libraryGeneration);
    const stillLatest = () => editorStore.isLatestAudioWrite(result.path, result.operation);
    const metadata = await libraryStore.refreshItem(result.path, pending.libraryGeneration, stillLatest);
    const refreshed = libraryStore.getState().items.find((entry) => entry.path === result.path);
    if (metadata && refreshed && stillLatest() && editorStore.isCurrentOwnership(pending.confirmation)) editorStore.setItem(refreshed);
    if (mounted.current) setConfirm(undefined);
  };
  const openWriteConfirmation = () => {
    const confirmation = editorStore.captureAudioWriteConfirmation();
    if (confirmation) setConfirm({ confirmation, libraryGeneration: libraryStore.getGeneration() });
  };
  const confirmationCurrent = Boolean(confirm && editorStore.isAudioWriteConfirmationCurrent(confirm.confirmation));
  const coverConfirmationCurrent = Boolean(coverConfirm && isCoverConfirmationCurrent(coverConfirm));

  return <aside className="pane details-pane" aria-label="Details">
    <h2>Details</h2><h3 data-testid="details-file-name">{item.fileName}</h3>{error && <p className="error-text" role="alert">{error}</p>}
    {suspected && <div className="guidance"><p>Suspected whole-track CUE. Use the whole-track CUE candidate flow.</p><button onClick={() => window.dispatchEvent(new CustomEvent("music-id3:override", { detail: item.path }))}>Use normal audio editing</button></div>}
    {candidateCueItem && <CueEditor key="candidate-cue" item={candidateCueItem} source={state.candidateSource} />}
    <div className="mode-tabs"><button aria-pressed={mode === "common"} onClick={() => setMode("common")}>Common tags</button><button aria-pressed={mode === "raw"} onClick={() => setMode("raw")}>Raw tags</button></div>
    {mode === "raw" ? <pre className="raw-tags" aria-label="raw tags read only" data-testid="raw-tags">{JSON.stringify(item.metadata.raw, null, 2)}</pre> : <>
      <div className="cover-controls">{currentCover ? <img className="cover-preview" alt="cover preview" src={`data:${currentCover.mimeType};base64,${currentCover.data}`} /> : <div className="cover-empty">No cover</div>}<span>{currentCover?.mimeType ?? "No cover selected"}</span><button onClick={openCoverConfirmation}>Remove cover</button><label className="file-button">Replace cover<input aria-label="cover file" type="file" accept="image/*" hidden onChange={(event) => readCover(event.target.files?.[0])} /></label></div>
      <div className="tag-editor">{fields.map((field) => <label key={field}><input type="checkbox" aria-label={field} checked={selectedFields.includes(field)} disabled={unsupported} onChange={(event) => editorStore.setFieldSelected(field, event.target.checked)} /><span>{field}{unsupported ? " (unsupported)" : ""}</span><input aria-label={`${field} value`} value={String(draft[field] ?? "")} disabled={suspected || unsupported} onChange={(event) => editorStore.setField(field, event.target.value)} /></label>)}</div>
      <button disabled={selectedFields.length === 0} onClick={() => editorStore.previewDiff()}>Preview diff</button>
      {diff.length > 0 && <div className="diff-preview" data-testid="metadata-diff">{diff.map((entry) => <div key={entry.field}><strong>{entry.field}</strong>: <del>{valueText(entry.oldValue)}</del> <ins>{valueText(entry.newValue)}</ins></div>)}<button onClick={openWriteConfirmation}>Write selected fields</button></div>}
    </>}
    {coverConfirmationCurrent && coverConfirm && <div role="dialog" className="confirm-dialog"><div className="dialog-body"><p>Clear cover art?</p><button onClick={() => { if (!isCoverConfirmationCurrent(coverConfirm)) { setCoverConfirm(undefined); return; } abortCoverRead(); selectCover(undefined); setCoverConfirm(undefined); }}>Confirm clear</button><button onClick={() => setCoverConfirm(undefined)}>Cancel</button></div></div>}
    {confirmationCurrent && confirm && <div role="dialog" className="confirm-dialog"><div className="dialog-body"><p>Confirm writing selected fields?</p><button aria-label="confirm write" onClick={() => void write(confirm)}>Confirm write</button><button onClick={() => setConfirm(undefined)}>Cancel</button></div></div>}
    <MetadataCandidates />
  </aside>;
}
