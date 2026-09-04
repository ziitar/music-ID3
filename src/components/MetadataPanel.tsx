import { useRef, useState } from "react";
import { editorStore, useEditorStore } from "../stores/editor-store";
import { libraryStore } from "../stores/library-store";
import type { CoverArt } from "../../shared/types";
import { CueEditor } from "./CueEditor";
import { MetadataCandidates } from "./MetadataCandidates";

function valueText(value: unknown): string {
  if (value && typeof value === "object" && "mimeType" in value) return (value as CoverArt).mimeType;
  return String(value ?? "");
}

export function MetadataPanel() {
  const state = useEditorStore((value) => value);
  const { item, draft, selectedFields, diff, cueDraft, error } = state;
  const [confirm, setConfirm] = useState(false);
  const [mode, setMode] = useState<"common" | "raw">("common");
  const [coverConfirm, setCoverConfirm] = useState(false);
  const coverOperation = useRef(0);
  if (!item) return <aside className="pane details-pane" aria-label="Details"><h2>Details</h2><p className="empty-state">Select a file to inspect.</p></aside>;
  const candidateCueItem = cueDraft ? { kind: "cue" as const, path: item.kind === "cue" ? item.path : `${item.path}.cue`, encoding: item.kind === "cue" ? item.encoding : "utf8" as const, rawText: "", parsed: cueDraft, referencedFiles: item.kind === "cue" ? item.referencedFiles : [item.path], missingReferencedFiles: [] } : undefined;
  if (item.kind === "cue") return <aside className="pane details-pane" aria-label="Details"><CueEditor key={`${item.path}:${candidateCueItem ? "candidate" : "local"}`} item={candidateCueItem ?? item} source={candidateCueItem ? state.candidateSource : undefined} /><MetadataCandidates /></aside>;
  const fields = ["title", "artist", "album", "albumArtist", "date", "genre", "comment"];
  const suspected = item.wholeTrackStatus === "suspected";
  const unsupported = item.extension === ".wv";
  const currentCover = draft.cover as CoverArt | undefined;
  const selectCover = (cover: CoverArt | undefined) => { editorStore.setField("cover", cover); editorStore.setFieldSelected("cover", true); };
  const readCover = (file?: File) => { if (!file) return; const operation = ++coverOperation.current; const targetPath = item.path; const editorGeneration = editorStore.getGeneration(); const isCurrent = () => operation === coverOperation.current && editorStore.isCurrentItem(targetPath, editorGeneration); const reader = new FileReader(); reader.onerror = () => { if (isCurrent()) editorStore.setError("Unable to read cover image"); }; reader.onload = () => { if (!isCurrent()) return; const bytes = new Uint8Array(reader.result as ArrayBuffer); let binary = ""; bytes.forEach((byte) => { binary += String.fromCharCode(byte); }); editorStore.setError(undefined); selectCover({ mimeType: file.type || "application/octet-stream", data: btoa(binary) }); }; reader.readAsArrayBuffer(file); };
  const write = async () => { const result = await editorStore.confirmAudioWrite(); if (!result?.ok) return; await libraryStore.refreshItem(item.path); setConfirm(false); };
  return <aside className="pane details-pane" aria-label="Details"><h2>Details</h2><h3>{item.fileName}</h3>{error && <p className="error-text" role="alert">{error}</p>}{suspected && <div className="guidance"><p>Suspected whole-track CUE. Use the whole-track CUE candidate flow.</p><button onClick={() => window.dispatchEvent(new CustomEvent("music-id3:override", { detail: item.path }))}>Use normal audio editing</button></div>}{candidateCueItem && <CueEditor key="candidate-cue" item={candidateCueItem} source={state.candidateSource} />}<div className="mode-tabs"><button aria-pressed={mode === "common"} onClick={() => setMode("common")}>Common tags</button><button aria-pressed={mode === "raw"} onClick={() => setMode("raw")}>Raw tags</button></div>{mode === "raw" ? <pre className="raw-tags" aria-label="raw tags read only">{JSON.stringify(item.metadata.raw, null, 2)}</pre> : <><div className="cover-controls">{currentCover ? <img className="cover-preview" alt="cover preview" src={`data:${currentCover.mimeType};base64,${currentCover.data}`} /> : <div className="cover-empty">No cover</div>}<span>{currentCover?.mimeType ?? "No cover selected"}</span><button onClick={() => setCoverConfirm(true)}>Remove cover</button><label className="file-button">Replace cover<input aria-label="cover file" type="file" accept="image/*" hidden onChange={(event) => readCover(event.target.files?.[0])} /></label></div><div className="tag-editor">{fields.map((field) => <label key={field}><input type="checkbox" aria-label={field} checked={selectedFields.includes(field)} disabled={unsupported} onChange={(event) => editorStore.setFieldSelected(field, event.target.checked)} /><span>{field}{unsupported ? " (unsupported)" : ""}</span><input aria-label={`${field} value`} value={String(draft[field] ?? "")} disabled={suspected || unsupported} onChange={(event) => editorStore.setField(field, event.target.value)} /></label>)}</div><button disabled={selectedFields.length === 0} onClick={() => editorStore.previewDiff()}>Preview diff</button>{diff.length > 0 && <div className="diff-preview">{diff.map((entry) => <div key={entry.field}><strong>{entry.field}</strong>: <del>{valueText(entry.oldValue)}</del> <ins>{valueText(entry.newValue)}</ins></div>)}<button onClick={() => setConfirm(true)}>Write selected fields</button></div>}</>}{coverConfirm && <div role="dialog" className="confirm-dialog"><div className="dialog-body"><p>Clear cover art?</p><button onClick={() => { coverOperation.current += 1; selectCover(undefined); setCoverConfirm(false); }}>Confirm clear</button><button onClick={() => setCoverConfirm(false)}>Cancel</button></div></div>}{confirm && <div role="dialog" className="confirm-dialog"><div className="dialog-body"><p>Confirm writing selected fields?</p><button aria-label="confirm write" onClick={write}>Confirm write</button><button onClick={() => setConfirm(false)}>Cancel</button></div></div>}<MetadataCandidates /></aside>;
}
