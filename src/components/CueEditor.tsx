import { useEffect, useRef, useState } from "react";
import { editorStore, useEditorStore, type EditorOwnership } from "../stores/editor-store";
import { libraryStore } from "../stores/library-store";
import type { CueDocument, LibraryItem, SaveCueInput } from "../../shared/types";

type CueSaveConfirmation = {
  ownership: EditorOwnership;
  targetPath: string;
  input: SaveCueInput;
  mode: "structured" | "raw";
  raw: string;
  document: CueDocument;
  encoding: SaveCueInput["encoding"];
  libraryGeneration: number;
  generated: boolean;
};

export function CueEditor({ item, source }: { item: Extract<LibraryItem, { kind: "cue" }>; source?: string }) {
  const [raw, setRaw] = useState(item.rawText);
  const [document, setDocument] = useState<CueDocument>(item.parsed);
  const [confirm, setConfirm] = useState<CueSaveConfirmation>();
  const [encoding, setEncoding] = useState(item.encoding);
  const [mode, setMode] = useState<"structured" | "raw">("structured");
  const [validationError, setValidationError] = useState(item.parseError);
  const [validatedRaw, setValidatedRaw] = useState<string | undefined>(item.parseError ? undefined : item.rawText);
  const rawRef = useRef(item.rawText);
  const previewGeneration = useRef(0);
  const editorState = useEditorStore((state) => state);
  const saveError = editorState.error;
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; previewGeneration.current += 1; }, []);
  useEffect(() => { previewGeneration.current += 1; rawRef.current = item.rawText; setRaw(item.rawText); setDocument(item.parsed); setEncoding(item.encoding); setValidationError(item.parseError); setValidatedRaw(item.parseError ? undefined : item.rawText); setConfirm(undefined); setMode("structured"); }, [item.path, item.rawText, item.parsed, item.encoding, item.parseError, editorState.generation]);
  const previewRaw = async () => { const requestedRaw = rawRef.current; const requestedPath = item.path; const generation = ++previewGeneration.current; const isCurrent = () => generation === previewGeneration.current && requestedPath === item.path && requestedRaw === rawRef.current; try { const preview = await window.musicId3.previewCue(requestedPath, requestedRaw); if (!isCurrent()) return; setValidationError(preview.parseError); setValidatedRaw(preview.parseError ? undefined : requestedRaw); if (!preview.parseError) setDocument(preview.parsed); } catch { if (!isCurrent()) return; setValidatedRaw(undefined); setValidationError("Unable to validate CUE text"); } };
  const updateTrack = (index: number, patch: Partial<CueDocument["tracks"][number]>) => setDocument((current) => ({ ...current, tracks: current.tracks.map((track, position) => position === index ? { ...track, ...patch } : track) }));
  const isConfirmationCurrent = (target: CueSaveConfirmation) => target.targetPath === item.path && target.mode === mode && target.raw === raw && target.document === document && target.encoding === encoding && editorStore.isCurrentOwnership(target.ownership);
  const openConfirmation = () => {
    const ownership = editorStore.captureOwnership();
    if (!ownership) return;
    setConfirm({ ownership, targetPath: item.path, input: { path: item.path, rawText: mode === "raw" ? raw : "", encoding, document }, mode, raw, document, encoding, libraryGeneration: libraryStore.getGeneration(), generated: ownership.path !== item.path });
  };
  const save = async (target: CueSaveConfirmation) => {
    if (!isConfirmationCurrent(target)) { if (mounted.current) setConfirm(undefined); return; }
    if (target.mode === "raw" && validatedRaw !== target.raw) { setValidationError("Validate edited CUE before saving"); return; }
    const result = await editorStore.saveCueDraft(target.input, target.ownership);
    if (!result?.ok || !result.latest || libraryStore.getGeneration() !== target.libraryGeneration) return;
    if (target.generated && !editorStore.isCurrentOwnership(target.ownership)) return;
    const expectedNewCue = target.generated ? { originatingAudioPath: target.ownership.path, isCurrent: () => editorStore.isCurrentOwnership(target.ownership) } : undefined;
    const refreshed = await libraryStore.refreshCue(target.targetPath, target.libraryGeneration, expectedNewCue);
    if (refreshed && editorStore.isCurrentOwnership(target.ownership)) {
      if (mounted.current) setConfirm(undefined);
      libraryStore.selectItem(target.targetPath);
      editorStore.setItem(refreshed);
    } else if (!refreshed && editorStore.isCurrentOwnership(target.ownership)) editorStore.setError("Unable to refresh CUE");
  };
  const confirmationCurrent = Boolean(confirm && isConfirmationCurrent(confirm));
  return <div className="cue-editor"><h3>CUE editor</h3><p className="source-banner">Source: {source ?? "local CUE"} · Confidence: {validationError ? "low" : "high"}</p>{validationError && <p className="error-text" role="alert">{validationError}</p>}{saveError && <p className="error-text" role="alert">{saveError}</p>}{item.missingReferencedFiles.length > 0 && <p className="warning-text">Missing references: {item.missingReferencedFiles.join(", ")}</p>}<div className="mode-tabs"><button aria-pressed={mode === "structured"} onClick={() => setMode("structured")}>Structured</button><button aria-pressed={mode === "raw"} onClick={() => setMode("raw")}>Raw</button></div><label>Encoding<select aria-label="encoding" value={encoding} onChange={(event) => setEncoding(event.target.value as typeof encoding)}><option value="utf8">UTF-8</option><option value="utf8-bom">UTF-8 BOM</option><option value="gb18030">GB18030</option><option value="gbk">GBK</option><option value="big5">Big5</option><option value="shift-jis">Shift-JIS</option></select></label>{item.candidateEncodings && item.candidateEncodings.length > 0 && <div className="encoding-candidates">Candidates: {item.candidateEncodings.map((candidate) => <button key={candidate} onClick={() => setEncoding(candidate)}>{candidate}</button>)}</div>}{mode === "raw" ? <textarea aria-label="raw cue" value={raw} onChange={(event) => { previewGeneration.current += 1; rawRef.current = event.target.value; setRaw(event.target.value); setValidatedRaw(undefined); setValidationError("Validate edited CUE before saving"); }} onBlur={previewRaw} /> : <div className="cue-structured"><label>Album title<input aria-label="cue album title" value={document.title ?? ""} onChange={(event) => setDocument({ ...document, title: event.target.value })} /></label><label>Album performer<input aria-label="cue album performer" value={document.performer ?? ""} onChange={(event) => setDocument({ ...document, performer: event.target.value })} /></label>{document.files.map((file, index) => <label key={index}>FILE {index + 1}<input aria-label={`cue file ${index + 1}`} value={file.path} onChange={(event) => setDocument({ ...document, files: document.files.map((entry, position) => position === index ? { ...entry, path: event.target.value } : entry) })} /></label>)}{document.tracks.map((track, index) => <fieldset key={track.number}><legend>Track {track.number}</legend><label>Title<input aria-label={`track ${track.number} title`} value={track.title ?? ""} onChange={(event) => updateTrack(index, { title: event.target.value })} /></label><label>Performer<input aria-label={`track ${track.number} performer`} value={track.performer ?? ""} onChange={(event) => updateTrack(index, { performer: event.target.value })} /></label><label>INDEX 01<input aria-label={`track ${track.number} index`} value={track.indexes.find((entry) => entry.number === 1)?.time ?? ""} onChange={(event) => updateTrack(index, { indexes: track.indexes.map((entry) => entry.number === 1 ? { ...entry, time: event.target.value } : entry) })} /></label><label>Pregap<input aria-label={`track ${track.number} pregap`} value={track.pregap ?? ""} onChange={(event) => updateTrack(index, { pregap: event.target.value })} /></label><label>Postgap<input aria-label={`track ${track.number} postgap`} value={track.postgap ?? ""} onChange={(event) => updateTrack(index, { postgap: event.target.value })} /></label></fieldset>)}</div>}<button disabled={Boolean(validationError) || (mode === "raw" && validatedRaw !== raw)} onClick={openConfirmation}>Save CUE</button>{confirmationCurrent && confirm && <div role="dialog" className="confirm-dialog"><div className="dialog-body"><p>Saving creates a .bak backup.</p><button onClick={() => void save(confirm)} aria-label="confirm cue save">Confirm CUE save</button><button onClick={() => setConfirm(undefined)}>Cancel</button></div></div>}</div>;
}
