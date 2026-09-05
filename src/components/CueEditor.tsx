import { useEffect, useRef, useState } from "react";
import type { CueDocument, CueEncoding, LibraryItem, PrepareCueSaveInput, SaveCueInput } from "../../shared/types";
import { editorStore, useEditorStore, type EditorOwnership } from "../stores/editor-store";
import { libraryStore } from "../stores/library-store";
import { useI18n } from "../i18n";

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
  const { locale, t, translateMessage } = useI18n();
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

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; previewGeneration.current += 1; };
  }, []);
  useEffect(() => {
    previewGeneration.current += 1;
    rawRef.current = item.rawText;
    setRaw(item.rawText);
    setDocument(item.parsed);
    setEncoding(item.encoding);
    setValidationError(item.parseError);
    setValidatedRaw(item.parseError ? undefined : item.rawText);
    setConfirm(undefined);
    setMode("structured");
  }, [item.path, item.rawText, item.parsed, item.encoding, item.parseError, editorState.generation]);

  const previewRaw = async () => {
    const requestedRaw = rawRef.current;
    const requestedPath = item.path;
    const generation = ++previewGeneration.current;
    const isCurrent = () => generation === previewGeneration.current && requestedPath === item.path && requestedRaw === rawRef.current;
    try {
      const preview = await window.musicId3.previewCue(requestedPath, requestedRaw);
      if (!isCurrent()) return;
      setValidationError(preview.parseError);
      setValidatedRaw(preview.parseError ? undefined : requestedRaw);
      if (!preview.parseError) setDocument(preview.parsed);
    } catch {
      if (!isCurrent()) return;
      setValidatedRaw(undefined);
      setValidationError("Unable to validate CUE text");
    }
  };

  const reloadSourceEncoding = async (selectedEncoding: CueEncoding) => {
    const requestedPath = item.path;
    const generation = ++previewGeneration.current;
    setConfirm(undefined);
    try {
      const decoded = await window.musicId3.readCue(requestedPath, selectedEncoding);
      if (!mounted.current || generation !== previewGeneration.current || requestedPath !== item.path) return;
      rawRef.current = decoded.rawText;
      setRaw(decoded.rawText);
      setDocument(decoded.parsed);
      setEncoding(decoded.encoding);
      setValidationError(decoded.parseError);
      setValidatedRaw(decoded.parseError ? undefined : decoded.rawText);
    } catch {
      if (!mounted.current || generation !== previewGeneration.current || requestedPath !== item.path) return;
      setValidationError("Unable to decode CUE with the selected source encoding");
    }
  };

  const updateTrack = (index: number, patch: Partial<CueDocument["tracks"][number]>) => setDocument((current) => ({ ...current, tracks: current.tracks.map((track, position) => position === index ? { ...track, ...patch } : track) }));
  const isConfirmationCurrent = (target: CueSaveConfirmation) => target.targetPath === item.path && target.mode === mode && target.raw === raw && target.document === document && target.encoding === encoding && editorStore.isCurrentOwnership(target.ownership);
  const openConfirmation = async () => {
    const ownership = editorStore.captureOwnership();
    if (!ownership) return;
    const input: PrepareCueSaveInput = { path: item.path, rawText: mode === "raw" ? raw : "", encoding, document };
    try {
      const confirmationToken = await window.musicId3.prepareCueSave(input);
      if (!mounted.current || !editorStore.isCurrentOwnership(ownership)) return;
      setConfirm({
        ownership,
        targetPath: item.path,
        input: { ...input, confirmationToken },
        mode,
        raw,
        document,
        encoding,
        libraryGeneration: libraryStore.getGeneration(),
        generated: ownership.path !== item.path
      });
    } catch {
      if (mounted.current && editorStore.isCurrentOwnership(ownership)) editorStore.setError("Unable to prepare CUE save");
    }
  };
  const save = async (target: CueSaveConfirmation) => {
    if (!isConfirmationCurrent(target)) { if (mounted.current) setConfirm(undefined); return; }
    if (target.mode === "raw" && validatedRaw !== target.raw) { setValidationError("Validate edited CUE before saving"); return; }
    setConfirm(undefined);
    const result = await editorStore.saveCueDraft(target.input, target.ownership);
    if (!result?.ok || !result.latest || libraryStore.getGeneration() !== target.libraryGeneration) return;
    if (target.generated && !editorStore.isCurrentOwnership(target.ownership)) return;
    const expectedNewCue = target.generated ? { originatingAudioPath: target.ownership.path, isCurrent: () => editorStore.isCurrentOwnership(target.ownership) } : undefined;
    const refreshed = await libraryStore.refreshCue(target.targetPath, target.libraryGeneration, expectedNewCue);
    if (refreshed && editorStore.isCurrentOwnership(target.ownership)) {
      libraryStore.selectItem(target.targetPath);
      editorStore.setItem(refreshed);
    } else if (!refreshed && editorStore.isCurrentOwnership(target.ownership)) editorStore.setError("Unable to refresh CUE");
  };

  const confirmationCurrent = Boolean(confirm && isConfirmationCurrent(confirm));
  const provenance = document.provenance;
  const confidence = provenance?.confidence ?? "unverified";
  const confidenceText = t(confidence === "high" ? "confidenceHigh" : confidence === "medium" ? "confidenceMedium" : confidence === "low" ? "confidenceLow" : "confidenceUnverified");
  const aria = (english: string, chinese: string) => locale === "zh-CN" ? chinese : english;
  return <div className="cue-editor">
    <h3>{t("cueEditor")}</h3>
    <p className="source-banner">{t("source")}: {source ? translateMessage(source) : t("localCue")} · {t("confidence")}: {confidenceText}</p>
    {provenance && <div className="cue-provenance">
      <p>{t("releaseId")}: {provenance.releaseId}</p>
      {provenance.discId && <p>{t("discId")}: {provenance.discId}</p>}
      {provenance.evidence.map((entry) => <p key={entry}>{translateMessage(entry)}</p>)}
      {provenance.inferred && <p className="warning-text">{t("inferredCandidate")}</p>}
    </div>}
    {validationError && <p className="error-text" role="alert">{translateMessage(validationError)}</p>}
    {saveError && <p className="error-text" role="alert">{translateMessage(saveError)}</p>}
    {item.missingReferencedFiles.length > 0 && <p className="warning-text">{t("missingReferences")}: {item.missingReferencedFiles.join(", ")}</p>}
    <div className="mode-tabs"><button aria-pressed={mode === "structured"} onClick={() => setMode("structured")}>{t("structured")}</button><button aria-pressed={mode === "raw"} onClick={() => setMode("raw")}>{t("raw")}</button></div>
    <label>{t("encoding")}<select aria-label={aria("encoding", t("encoding"))} value={encoding} onChange={(event) => setEncoding(event.target.value as CueEncoding)}><option value="utf8">UTF-8</option><option value="utf8-bom">UTF-8 BOM</option><option value="gb18030">GB18030</option><option value="gbk">GBK</option><option value="big5">Big5</option><option value="shift-jis">Shift-JIS</option></select></label>
    {item.candidateEncodings && item.candidateEncodings.length > 0 && <div className="encoding-candidates">{t("sourcePreviews")}: {item.candidateEncodings.map((candidate) => <button key={candidate} onClick={() => void reloadSourceEncoding(candidate)}>{t("decodeAs", { encoding: candidate })}</button>)}</div>}
    {mode === "raw" ? <textarea aria-label={aria("raw cue", t("rawCue"))} value={raw} onChange={(event) => { previewGeneration.current += 1; rawRef.current = event.target.value; setRaw(event.target.value); setValidatedRaw(undefined); setValidationError("Validate edited CUE before saving"); }} onBlur={previewRaw} /> : <div className="cue-structured">
      <label>{t("albumTitle")}<input aria-label={aria("cue album title", t("albumTitle"))} value={document.title ?? ""} onChange={(event) => setDocument({ ...document, title: event.target.value })} /></label>
      <label>{t("albumPerformer")}<input aria-label={aria("cue album performer", t("albumPerformer"))} value={document.performer ?? ""} onChange={(event) => setDocument({ ...document, performer: event.target.value })} /></label>
      {document.files.map((file, index) => <label key={index}>FILE {index + 1}<input aria-label={aria(`cue file ${index + 1}`, `CUE 文件 ${index + 1}`)} value={file.path} onChange={(event) => setDocument({ ...document, files: document.files.map((entry, position) => position === index ? { ...entry, path: event.target.value } : entry) })} /></label>)}
      {document.tracks.map((track, index) => <fieldset key={track.number}><legend>{t("track", { number: track.number })}</legend><label>{t("title")}<input aria-label={aria(`track ${track.number} title`, `音轨 ${track.number} 标题`)} value={track.title ?? ""} onChange={(event) => updateTrack(index, { title: event.target.value })} /></label><label>{t("performer")}<input aria-label={aria(`track ${track.number} performer`, `音轨 ${track.number} 表演者`)} value={track.performer ?? ""} onChange={(event) => updateTrack(index, { performer: event.target.value })} /></label><label>INDEX 01<input aria-label={aria(`track ${track.number} index`, `音轨 ${track.number} 索引`)} value={track.indexes.find((entry) => entry.number === 1)?.time ?? ""} onChange={(event) => updateTrack(index, { indexes: track.indexes.map((entry) => entry.number === 1 ? { ...entry, time: event.target.value } : entry) })} /></label><label>{t("pregap")}<input aria-label={aria(`track ${track.number} pregap`, `音轨 ${track.number} 前置间隙`)} value={track.pregap ?? ""} onChange={(event) => updateTrack(index, { pregap: event.target.value })} /></label><label>{t("postgap")}<input aria-label={aria(`track ${track.number} postgap`, `音轨 ${track.number} 后置间隙`)} value={track.postgap ?? ""} onChange={(event) => updateTrack(index, { postgap: event.target.value })} /></label></fieldset>)}
    </div>}
    <button disabled={Boolean(validationError) || (mode === "raw" && validatedRaw !== raw)} onClick={() => void openConfirmation()}>{t("saveCue")}</button>
    {confirmationCurrent && confirm && <div role="dialog" className="confirm-dialog"><div className="dialog-body">
      {confirm.generated ? <p>{t("createsNewCue")}</p> : <p>{t("createsBackup")}</p>}
      {provenance?.inferred && provenance.confidence === "low" && <p className="warning-text">{t("reviewLowConfidence")}</p>}
      <button onClick={() => void save(confirm)} aria-label={t("confirmCueSave")}>{t("confirmCueSave")}</button><button onClick={() => setConfirm(undefined)}>{t("cancel")}</button>
    </div></div>}
  </div>;
}
