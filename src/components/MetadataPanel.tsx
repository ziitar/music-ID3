import { useEffect, useRef, useState } from "react";
import { editorStore, useEditorStore, type AudioWriteConfirmation, type EditorOwnership } from "../stores/editor-store";
import { libraryStore } from "../stores/library-store";
import type { CoverArt } from "../../shared/types";
import { CueEditor } from "./CueEditor";
import { MetadataCandidates } from "./MetadataCandidates";
import { useI18n } from "../i18n";

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
  const { locale, t, translateMessage } = useI18n();
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

  if (!item) return <aside className="pane details-pane" aria-label={t("details")}><h2>{t("details")}</h2><p className="empty-state">{t("selectFile")}</p></aside>;
  const candidateCueItem = cueDraft ? { kind: "cue" as const, path: item.kind === "cue" ? item.path : `${item.path}.cue`, encoding: item.kind === "cue" ? item.encoding : "utf8-bom" as const, rawText: "", parsed: cueDraft, referencedFiles: item.kind === "cue" ? item.referencedFiles : [item.path], missingReferencedFiles: [] } : undefined;
  if (item.kind === "cue") return <aside className="pane details-pane" aria-label={t("details")}><MetadataCandidates /><CueEditor key={`${item.path}:${candidateCueItem ? "candidate" : "local"}`} item={candidateCueItem ?? item} source={candidateCueItem ? state.candidateSource : undefined} /></aside>;

  const fields = [
    { name: "title", numeric: false }, { name: "artist", numeric: false }, { name: "album", numeric: false },
    { name: "albumArtist", numeric: false }, { name: "trackNumber", numeric: true }, { name: "trackTotal", numeric: true },
    { name: "discNumber", numeric: true }, { name: "discTotal", numeric: true }, { name: "date", numeric: false },
    { name: "genre", numeric: false }, { name: "composer", numeric: false }, { name: "comment", numeric: false },
    { name: "lyrics", numeric: false }, { name: "copyright", numeric: false }
  ] as const;
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

  return <aside className="pane details-pane" aria-label={t("details")}>
    <h2>{t("details")}</h2><h3 data-testid="details-file-name">{item.fileName}</h3>{error && <p className="error-text" role="alert">{translateMessage(error)}</p>}
    {suspected && <div className="guidance"><p>{t("suspectedCue")}</p><button onClick={() => window.dispatchEvent(new CustomEvent("music-id3:override", { detail: item.path }))}>{t("normalAudioEditing")}</button></div>}
    <MetadataCandidates />
    {candidateCueItem && <CueEditor key="candidate-cue" item={candidateCueItem} source={state.candidateSource} />}
    <div className="mode-tabs"><button aria-pressed={mode === "common"} onClick={() => setMode("common")}>{t("commonTags")}</button><button aria-pressed={mode === "raw"} onClick={() => setMode("raw")}>{t("rawTags")}</button></div>
    {mode === "raw" ? <pre className="raw-tags" aria-label={t("rawTagsReadOnly")} data-testid="raw-tags">{JSON.stringify(item.metadata.raw, null, 2)}</pre> : <>
      <div className="cover-controls">{currentCover ? <img className="cover-preview" alt={t("coverPreview")} src={`data:${currentCover.mimeType};base64,${currentCover.data}`} /> : <div className="cover-empty">{t("noCover")}</div>}<span>{currentCover?.mimeType ?? t("noCoverSelected")}</span><button disabled={suspected || unsupported} onClick={openCoverConfirmation}>{t("removeCover")}</button><label className="file-button">{t("replaceCover")}<input aria-label={t("coverFile")} type="file" accept="image/*" hidden disabled={suspected || unsupported} onChange={(event) => readCover(event.target.files?.[0])} /></label></div>
      <div className="tag-editor">{fields.map((field) => { const label = t(field.name); return <label key={field.name}><input type="checkbox" aria-label={locale === "zh-CN" ? label : field.name} checked={selectedFields.includes(field.name)} disabled={suspected || unsupported} onChange={(event) => editorStore.setFieldSelected(field.name, event.target.checked)} /><span>{label}{unsupported ? ` (${t("unsupported")})` : ""}</span><input aria-label={locale === "zh-CN" ? `${label}值` : `${field.name} value`} type={field.numeric ? "number" : "text"} {...(field.numeric ? { min: 0, step: 1 } : {})} value={String(draft[field.name] ?? "")} disabled={suspected || unsupported} onChange={(event) => editorStore.setField(field.name, field.numeric ? (event.target.value === "" ? undefined : Number(event.target.value)) : event.target.value)} /></label>; })}</div>
      <button disabled={suspected || unsupported || selectedFields.length === 0} onClick={() => editorStore.previewDiff()}>{t("previewDiff")}</button>
      {diff.length > 0 && <div className="diff-preview" data-testid="metadata-diff">{diff.map((entry) => <div key={entry.field}><strong>{t(entry.field as typeof fields[number]["name"])}</strong>: <del>{valueText(entry.oldValue)}</del> <ins>{valueText(entry.newValue)}</ins></div>)}<button onClick={openWriteConfirmation}>{t("writeSelectedFields")}</button></div>}
    </>}
    {coverConfirmationCurrent && coverConfirm && <div role="dialog" className="confirm-dialog"><div className="dialog-body"><p>{t("clearCoverQuestion")}</p><button onClick={() => { if (!isCoverConfirmationCurrent(coverConfirm)) { setCoverConfirm(undefined); return; } abortCoverRead(); selectCover(undefined); setCoverConfirm(undefined); }}>{t("confirmClear")}</button><button onClick={() => setCoverConfirm(undefined)}>{t("cancel")}</button></div></div>}
    {confirmationCurrent && confirm && <div role="dialog" className="confirm-dialog"><div className="dialog-body"><p>{t("confirmWriteQuestion")}</p><button aria-label={t("confirmWrite")} onClick={() => void write(confirm)}>{t("confirmWrite")}</button><button onClick={() => setConfirm(undefined)}>{t("cancel")}</button></div></div>}
  </aside>;
}
