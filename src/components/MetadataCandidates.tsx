import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowLeft, ArrowRight, Check, ChevronLeft, ChevronRight, CloudDownload, Disc3, GripHorizontal, LoaderCircle, Music2, Search } from "lucide-react";
import type { CommonMetadata, CoverArt, MetadataCandidate, MetadataSource } from "../../shared/types";
import { editorStore, useEditorStore, type AudioWriteConfirmation } from "../stores/editor-store";
import { libraryStore } from "../stores/library-store";
import { useI18n } from "../i18n";

const candidateFields = [
  "title", "artist", "albumArtist", "album", "trackNumber", "trackTotal", "discNumber", "discTotal",
  "date", "genre", "composer", "comment", "lyrics", "copyright", "cover"
] as const satisfies ReadonlyArray<keyof CommonMetadata>;

type CandidateField = typeof candidateFields[number];
type PendingCandidate = { candidate: MetadataCandidate; confirmation: AudioWriteConfirmation; libraryGeneration: number };

function defaultQuery(state: ReturnType<typeof editorStore.getState>): string {
  const item = state.item;
  if (!item) return "";
  if (item.kind === "cue") return [item.parsed.performer, item.parsed.title].filter(Boolean).join(" ");
  const common = item.metadata.common;
  const albumFlow = item.wholeTrackStatus === "suspected";
  const metadataQuery = albumFlow
    ? [common.albumArtist ?? common.artist, common.album ?? common.title].filter(Boolean).join(" ")
    : [common.artist ?? common.albumArtist, common.title ?? common.album].filter(Boolean).join(" ");
  return metadataQuery.trim() || item.fileName.replace(/\.[^.]+$/, "");
}

function candidateKey(candidate: MetadataCandidate): string {
  return `${candidate.source}:${candidate.id}`;
}

function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined || durationMs <= 0) return "--:--";
  const seconds = Math.round(durationMs / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const tail = String(seconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${tail}` : `${minutes}:${tail}`;
}

function durationMatch(localMs: number | undefined, cloudMs: number | undefined): { kind: "close" | "review" | "different" | "unknown"; delta?: number } {
  if (!localMs || !cloudMs) return { kind: "unknown" };
  const delta = Math.abs(localMs - cloudMs);
  const closeLimit = Math.max(2000, Math.max(localMs, cloudMs) * 0.01);
  const reviewLimit = Math.max(5000, Math.max(localMs, cloudMs) * 0.03);
  return { kind: delta <= closeLimit ? "close" : delta <= reviewLimit ? "review" : "different", delta };
}

function candidateValue(candidate: MetadataCandidate, field: CandidateField): unknown {
  if (field === "title") return candidate.title;
  if (field === "date" && typeof candidate.date === "string") return candidate.date.match(/^\d{4}/)?.[0] ?? candidate.date;
  const value = candidate[field];
  if (["trackNumber", "trackTotal", "discNumber", "discTotal"].includes(field)) return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  if (field === "cover") return value;
  return typeof value === "string" ? value : undefined;
}

function hasCandidateValue(value: unknown): boolean {
  return value !== undefined && value !== null && (typeof value !== "string" || value.trim() !== "");
}

function defaultSelectedFields(candidate: MetadataCandidate): CandidateField[] {
  return candidateFields.filter((field) => hasCandidateValue(candidateValue(candidate, field)));
}

function displayValue(value: unknown, missing: string, coverLabel: string): string {
  if (value === undefined || value === null || value === "") return missing;
  if (typeof value === "object" && "mimeType" in value) return `${coverLabel} (${(value as CoverArt).mimeType})`;
  return String(value);
}

function Cover({ cover, alt, compact = false }: { cover?: CoverArt; alt: string; compact?: boolean }) {
  return cover
    ? <img className={compact ? "record-cover compact" : "record-cover"} alt={alt} src={`data:${cover.mimeType};base64,${cover.data}`} />
    : <div className={compact ? "record-cover cover-placeholder compact" : "record-cover cover-placeholder"}><Disc3 aria-hidden="true" /><Music2 aria-hidden="true" /></div>;
}

export function MetadataCandidates() {
  const { locale, t, translateMessage } = useI18n();
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<MetadataSource>("netease");
  const lastSuccessfulSource = useRef<MetadataSource>("netease");
  const [selected, setSelected] = useState<CandidateField[]>([]);
  const [focusedKey, setFocusedKey] = useState<string>();
  const [loadedKeys, setLoadedKeys] = useState<Set<string>>(() => new Set());
  const [pending, setPending] = useState<PendingCandidate>();
  const [activeIndex, setActiveIndex] = useState(0);
  const [dragX, setDragX] = useState(0);
  const dragStart = useRef<number | undefined>(undefined);
  const mounted = useRef(true);
  const state = useEditorStore((value) => value);
  const cueFlow = state.item?.kind === "cue" || state.item?.wholeTrackStatus === "suspected";
  const sources: Array<{ value: MetadataSource; label: string }> = cueFlow
    ? [{ value: "musicbrainz", label: "MusicBrainz" }]
    : [{ value: "musicbrainz", label: "MusicBrainz" }, { value: "netease", label: "NetEase" }, { value: "qq", label: "QQ Music" }];
  const focused = state.candidates.find((candidate) => candidateKey(candidate) === focusedKey);
  const localDuration = state.item?.kind === "audio" ? state.item.durationMs : undefined;
  const localFields = state.item?.kind === "audio" ? state.item.metadata.common : {};

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    setSource(cueFlow ? "musicbrainz" : lastSuccessfulSource.current);
    setQuery(defaultQuery(editorStore.getState()));
    setSelected([]);
    setFocusedKey(undefined);
    setLoadedKeys(new Set());
    setPending(undefined);
    setActiveIndex(0);
    setDragX(0);
  }, [state.generation, cueFlow]);
  useEffect(() => {
    if (!state.candidates.length) return;
    const index = focusedKey ? state.candidates.findIndex((candidate) => candidateKey(candidate) === focusedKey) : -1;
    if (index >= 0) setActiveIndex(index);
  }, [state.candidates, focusedKey]);

  const toggleField = (field: CandidateField) => {
    if (!focused || !hasCandidateValue(candidateValue(focused, field))) return;
    setSelected((current) => current.includes(field) ? current.filter((entry) => entry !== field) : [...current, field]);
  };
  const loadDetails = async (candidate: MetadataCandidate) => {
    setFocusedKey(candidateKey(candidate));
    const result = await editorStore.loadCandidateDetails(candidate);
    if (result && mounted.current) {
      setLoadedKeys((current) => new Set(current).add(candidateKey(result)));
      setSelected(defaultSelectedFields(result));
    }
  };
  const searchCandidates = async () => {
    setFocusedKey(undefined);
    setLoadedKeys(new Set());
    setPending(undefined);
    setActiveIndex(0);
    const results = await editorStore.searchCandidates(source, query);
    if (results.length > 0 && mounted.current) lastSuccessfulSource.current = source;
  };
  const apply = async (candidate: MetadataCandidate) => {
    setFocusedKey(candidateKey(candidate));
    const item = editorStore.getState().item;
    const result = await editorStore.applyCandidate(candidate, selected, loadedKeys.has(candidateKey(candidate)));
    if (item?.kind === "audio" && item.wholeTrackStatus !== "suspected" && result && mounted.current) {
      const confirmation = editorStore.captureAudioWriteConfirmation();
      if (confirmation) setPending({ candidate: result.candidate, confirmation, libraryGeneration: libraryStore.getGeneration() });
    }
  };
  const confirm = async (target: PendingCandidate) => {
    const result = await editorStore.confirmAudioWrite(target.confirmation);
    if (!result?.ok || !result.latest) return;
    libraryStore.updateAudioMetadata(result.path, result.metadata, target.libraryGeneration);
    const stillLatest = () => editorStore.isLatestAudioWrite(result.path, result.operation);
    const metadata = await libraryStore.refreshItem(result.path, target.libraryGeneration, stillLatest);
    const refreshed = libraryStore.getState().items.find((entry) => entry.path === result.path);
    if (metadata && refreshed && stillLatest() && editorStore.isCurrentOwnership(target.confirmation)) editorStore.setItem(refreshed);
    if (mounted.current) setPending(undefined);
  };
  const focusIndex = (index: number, load = true) => {
    const bounded = Math.max(0, Math.min(state.candidates.length - 1, index));
    const candidate = state.candidates[bounded];
    if (!candidate) return;
    setActiveIndex(bounded);
    setFocusedKey(candidateKey(candidate));
    setSelected(defaultSelectedFields(candidate));
    setDragX(0);
    if (load && !loadedKeys.has(candidateKey(candidate))) void loadDetails(candidate);
  };
  const step = (direction: -1 | 1) => focusIndex(activeIndex + direction);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragStart.current = event.clientX;
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragStart.current === undefined) return;
    const delta = event.clientX - dragStart.current;
    if (Math.abs(delta) > 4 && !event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    setDragX(Math.max(-140, Math.min(140, delta)));
  };
  const onPointerUp = () => {
    if (dragX < -55) step(1);
    else if (dragX > 55) step(-1);
    else setDragX(0);
    dragStart.current = undefined;
  };
  const pendingCurrent = Boolean(pending && editorStore.isAudioWriteConfirmationCurrent(pending.confirmation));
  const confidenceLabel = (confidence: MetadataCandidate["confidence"]) => t(confidence === "high" ? "confidenceHigh" : confidence === "medium" ? "confidenceMedium" : "confidenceLow");
  const availableSelected = (candidate: MetadataCandidate) => selected.filter((field) => hasCandidateValue(candidateValue(candidate, field)));
  const durationState = focused ? durationMatch(localDuration, focused.totalDurationMs) : { kind: "unknown" as const };
  const localItem = state.item?.kind === "audio" ? state.item : undefined;

  return <section className="candidate-panel" aria-label={t("metadataCandidates")}>
    <div className="candidate-heading"><div><h3>{t("metadataCandidates")}</h3><small>{t("durationPrimaryHint")}</small></div><span className="result-count">{state.candidates.length ? t("candidateCount", { count: state.candidates.length }) : t("readyToSearch")}</span></div>
    <div className="candidate-search">
      <select aria-label={locale === "zh-CN" ? t("provider") : "provider"} value={source} onChange={(event) => setSource(event.target.value as MetadataSource)}>{sources.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}</select>
      <label><Search aria-hidden="true" /><input aria-label={locale === "zh-CN" ? t("candidateQuery") : "candidate query"} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && query.trim() && !state.searching) void searchCandidates(); }} /></label>
      <button className="primary-action" disabled={!query.trim() || state.searching} onClick={() => void searchCandidates()}>{state.searching ? <LoaderCircle className="spin" aria-hidden="true" /> : <Search aria-hidden="true" />}{t("search")}</button>
    </div>
    {state.searchCompleted && state.candidates.length === 0 && !state.error && <p className="empty-state">{t("noCandidates")}</p>}
    {(localItem || state.candidates.length > 0) && <div className="metadata-stage">
      {localItem && <article className="original-record-card">
        <span className="paper-label">{t("originalFile")}</span>
        <Cover cover={localFields.cover as CoverArt | undefined} alt={t("coverPreview")} />
        <div className="record-copy"><h4>{localFields.title || localItem.fileName}</h4><strong>{localFields.artist || t("unknownArtist")}</strong><span>{localFields.album || t("notProvided")}</span><small>{formatDuration(localDuration)} · {localItem.extension.slice(1).toUpperCase()}</small></div>
      </article>}
      <div className="candidate-deck-region">
        <div className="deck-title"><span>{t("onlineCandidates")}</span>{state.candidates.length > 0 && <span><GripHorizontal aria-hidden="true" />{t("swipeCandidates")}</span>}</div>
        {state.candidates.length > 0 ? <div className="candidate-deck" tabIndex={0} role="group" aria-label={t("candidateResults")} onKeyDown={(event) => { if (event.key === "ArrowLeft") step(-1); if (event.key === "ArrowRight") step(1); }} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
          {state.candidates.map((candidate, index) => {
            const offset = index - activeIndex;
            const active = index === activeIndex;
            const match = durationMatch(localDuration, candidate.totalDurationMs);
            const style = { "--card-offset": offset, "--card-depth": `${Math.abs(offset) * 8}px`, "--drag-x": active ? `${dragX}px` : "0px", zIndex: active ? 20 : 10 - Math.abs(offset) } as CSSProperties;
            return <button type="button" className={`candidate-card ${active ? "active" : ""} ${Math.abs(offset) > 3 ? "far" : ""}`} style={style} data-testid="metadata-candidate" key={candidateKey(candidate)} aria-pressed={active} onClick={() => focusIndex(index)}>
              <div className="candidate-source"><span>{candidate.source === "musicbrainz" ? "MusicBrainz" : candidate.source === "netease" ? t("neteaseMusic") : candidate.source === "qq" ? t("qqMusic") : candidate.source}</span><strong className={`confidence confidence-${candidate.confidence}`}>{confidenceLabel(candidate.confidence)}</strong></div>
              <Cover cover={candidate.cover} alt={t("candidateCover")} compact />
              <div className="candidate-card-copy"><h4>{candidate.title}</h4><strong>{candidate.artist ?? t("unknownArtist")}</strong><span>{candidate.album ?? t("notProvided")}</span><small className={`duration-${match.kind}`}>{formatDuration(candidate.totalDurationMs)} · {match.kind === "close" ? t("durationClose") : match.kind === "different" ? t("durationDifferent") : t("durationReview")}</small></div>
            </button>;
          })}
        </div> : <div className="deck-empty"><CloudDownload aria-hidden="true" /><span>{t("searchForCandidates")}</span></div>}
        {state.candidates.length > 0 && <div className="deck-controls"><button className="icon-button" aria-label={t("previousCandidate")} disabled={activeIndex === 0} onClick={() => step(-1)}><ChevronLeft aria-hidden="true" /></button><div className="deck-dots">{state.candidates.map((candidate, index) => <button aria-label={t("showCandidate", { index: index + 1 })} aria-pressed={index === activeIndex} key={candidateKey(candidate)} onClick={() => focusIndex(index)} />)}</div><button className="icon-button" aria-label={t("nextCandidate")} disabled={activeIndex === state.candidates.length - 1} onClick={() => step(1)}><ChevronRight aria-hidden="true" /></button></div>}
      </div>
    </div>}
    {focused && <div className="candidate-comparison" data-testid="candidate-comparison">
      <div className="comparison-title"><div><h4>{t("compareMetadata")}</h4><span>{focused.source === "musicbrainz" ? "MusicBrainz" : focused.source === "netease" ? t("neteaseMusic") : t("qqMusic")}</span></div>{!loadedKeys.has(candidateKey(focused)) && <button className="secondary-action" onClick={() => void loadDetails(focused)}><CloudDownload aria-hidden="true" />{t("loadCandidateDetails")}</button>}</div>
      <div className={`duration-comparison duration-${durationState.kind}`}>
        <div><span>{t("localDuration")}</span><strong>{formatDuration(localDuration)}</strong></div>
        <div className="duration-verdict"><strong>{durationState.kind === "close" ? t("durationClose") : durationState.kind === "review" ? t("durationReview") : durationState.kind === "different" ? t("durationDifferent") : t("durationUnknown")}</strong>{durationState.delta !== undefined && <span>{t("durationDelta", { seconds: (durationState.delta / 1000).toFixed(1) })}</span>}</div>
        <div><span>{t("cloudDuration")}</span><strong>{formatDuration(focused.totalDurationMs)}</strong></div>
      </div>
      {!cueFlow && <>
        <div className="comparison-header"><strong>{t("localMetadata")}</strong><span>{t("transfer")}</span><strong>{t("cloudMetadata")}</strong></div>
        <div className="comparison-fields">
          {candidateFields.map((field) => {
            const remote = candidateValue(focused, field);
            const available = hasCandidateValue(remote);
            const chosen = selected.includes(field) && available;
            const different = displayValue(localFields[field], "", "") !== displayValue(remote, "", "");
            return <div className={`comparison-row ${chosen ? "selected" : ""} ${different ? "different" : ""}`} key={field}>
              <div className="comparison-value"><span>{t(field)}</span><strong>{displayValue(localFields[field], t("notProvided"), t("cover"))}</strong></div>
              <button className="transfer-button" disabled={!available} aria-label={t("transferField", { field: t(field) })} aria-pressed={chosen} title={t("transferField", { field: t(field) })} onClick={() => toggleField(field)}>{chosen ? <Check aria-hidden="true" /> : <ArrowRight aria-hidden="true" />}</button>
              <div className={`comparison-value remote ${available ? "" : "missing"}`}><span>{t(field)}</span><strong>{displayValue(remote, t("notProvided"), t("cover"))}</strong></div>
            </div>;
          })}
        </div>
        <div className="comparison-footer"><span>{t("selectedFieldCount", { count: availableSelected(focused).length })}</span><button className="primary-action" disabled={availableSelected(focused).length === 0} onClick={() => void apply(focused)}><ArrowLeft aria-hidden="true" />{t("overwriteSelectedFields")}</button></div>
      </>}
      {cueFlow && <div className="comparison-footer"><span>{focused.warnings?.map((warning) => translateMessage(warning)).join(" · ")}</span><button className="primary-action" onClick={() => void apply(focused)}>{t("applyCandidate")}</button></div>}
    </div>}
    {pendingCurrent && pending && <div className="dialog-backdrop"><section role="dialog" aria-modal="true" className="candidate-write-dialog"><header><div><h3>{t("confirmOverwrite")}</h3><p>{t("reviewChanges")}</p></div><button className="icon-button" aria-label={t("closeConfirmation")} onClick={() => setPending(undefined)}><ChevronRight aria-hidden="true" /></button></header><div className="write-dialog-list">{pending.confirmation.diff.map((entry) => <div key={entry.field}><strong>{t(entry.field as CandidateField)}</strong><del>{displayValue(entry.oldValue, t("notProvided"), t("cover"))}</del><ArrowRight aria-hidden="true" /><ins>{displayValue(entry.newValue, t("notProvided"), t("cover"))}</ins></div>)}</div><footer><button className="secondary-action" onClick={() => setPending(undefined)}>{t("cancel")}</button><button className="primary-action" onClick={() => void confirm(pending)} aria-label={t("confirmCandidateWrite")}><Check aria-hidden="true" />{t("confirmCandidateWrite")}</button></footer></section></div>}
  </section>;
}
