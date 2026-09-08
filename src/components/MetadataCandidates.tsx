import { useEffect, useRef, useState } from "react";
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
  return albumFlow
    ? [common.albumArtist ?? common.artist, common.album ?? common.title].filter(Boolean).join(" ")
    : [common.artist ?? common.albumArtist, common.title ?? common.album].filter(Boolean).join(" ");
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
  if (field === "date" && candidate.date) return candidate.date.match(/^\d{4}/)?.[0] ?? candidate.date;
  return candidate[field];
}

function displayValue(value: unknown, missing: string, coverLabel: string): string {
  if (value === undefined || value === null || value === "") return missing;
  if (typeof value === "object" && "mimeType" in value) return `${coverLabel} (${(value as CoverArt).mimeType})`;
  return String(value);
}

export function MetadataCandidates() {
  const { locale, t, translateMessage } = useI18n();
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<MetadataSource>("musicbrainz");
  const [selected, setSelected] = useState<CandidateField[]>(["title", "artist", "album"]);
  const [focusedKey, setFocusedKey] = useState<string>();
  const [loadedKeys, setLoadedKeys] = useState<Set<string>>(() => new Set());
  const [pending, setPending] = useState<PendingCandidate>();
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
    setSource("musicbrainz");
    setQuery(defaultQuery(editorStore.getState()));
    setSelected(["title", "artist", "album"]);
    setFocusedKey(undefined);
    setLoadedKeys(new Set());
    setPending(undefined);
  }, [state.generation, cueFlow]);

  const toggleField = (field: CandidateField) => {
    if (!focused || candidateValue(focused, field) === undefined) return;
    setSelected((current) => current.includes(field) ? current.filter((entry) => entry !== field) : [...current, field]);
  };
  const loadDetails = async (candidate: MetadataCandidate) => {
    setFocusedKey(candidateKey(candidate));
    const result = await editorStore.loadCandidateDetails(candidate);
    if (result && mounted.current) setLoadedKeys((current) => new Set(current).add(candidateKey(result)));
  };
  const search = async () => {
    setFocusedKey(undefined);
    setLoadedKeys(new Set());
    setPending(undefined);
    await editorStore.searchCandidates(source, query);
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
  const pendingCurrent = Boolean(pending && editorStore.isAudioWriteConfirmationCurrent(pending.confirmation));
  const confidenceLabel = (confidence: MetadataCandidate["confidence"]) => t(confidence === "high" ? "confidenceHigh" : confidence === "medium" ? "confidenceMedium" : "confidenceLow");
  const availableSelected = (candidate: MetadataCandidate) => selected.filter((field) => candidateValue(candidate, field) !== undefined);
  const durationState = focused ? durationMatch(localDuration, focused.totalDurationMs) : { kind: "unknown" as const };

  return <section className="candidate-panel" aria-label={t("metadataCandidates")}>
    <div className="candidate-heading"><div><h3>{t("metadataCandidates")}</h3><small>{t("durationPrimaryHint")}</small></div></div>
    <div className="candidate-search">
      <select aria-label={locale === "zh-CN" ? t("provider") : "provider"} value={source} onChange={(event) => setSource(event.target.value as MetadataSource)}>{sources.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}</select>
      <input aria-label={locale === "zh-CN" ? t("candidateQuery") : "candidate query"} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && query.trim() && !state.searching) void search(); }} />
      <button disabled={!query.trim() || state.searching} onClick={() => void search()}>{t("search")}</button>
    </div>
    {state.searching && <p role="status">{t("searching")}</p>}
    {state.searchCompleted && state.candidates.length === 0 && !state.error && <p className="empty-state">{t("noCandidates")}</p>}
    {state.candidates.length > 0 && <div className="candidate-results" aria-label={t("candidateResults")}>
      {state.candidates.map((candidate) => {
        const match = durationMatch(localDuration, candidate.totalDurationMs);
        const active = focused ? candidateKey(candidate) === candidateKey(focused) : false;
        return <article className={`candidate-row ${active ? "active" : ""}`} data-testid="metadata-candidate" key={candidateKey(candidate)} onClick={() => setFocusedKey(candidateKey(candidate))}>
          <div className="candidate-summary">{candidate.cover && <img className="candidate-cover" alt={t("candidateCover")} src={`data:${candidate.cover.mimeType};base64,${candidate.cover.data}`} />}<strong>{candidate.title}</strong><span>{candidate.artist ?? t("unknownArtist")}</span><small>{[candidate.album, candidate.date].filter(Boolean).join(" / ")}</small></div>
          <div className={`duration-chip duration-${match.kind}`}><span>{formatDuration(candidate.totalDurationMs)}</span><small>{match.delta === undefined ? t("durationUnknown") : t("durationDelta", { seconds: (match.delta / 1000).toFixed(1) })}</small></div>
          <span className={`confidence confidence-${candidate.confidence}`}>{confidenceLabel(candidate.confidence)}</span>
          <div className="candidate-field-shortcuts">
            {candidateFields.map((field) => { const available = candidateValue(candidate, field) !== undefined; return <label key={field}><input type="checkbox" aria-label={locale === "zh-CN" ? t(field) : field} checked={available && selected.includes(field)} disabled={!available} onChange={(event) => setSelected((current) => event.target.checked ? [...new Set([...current, field])] : current.filter((entry) => entry !== field))} />{t(field)}</label>; })}
          </div>
          <div className="candidate-actions">
            {!loadedKeys.has(candidateKey(candidate)) && <button onClick={(event) => { event.stopPropagation(); void loadDetails(candidate); }}>{t("loadCandidateDetails")}</button>}
            <button disabled={!cueFlow && availableSelected(candidate).length === 0} onClick={(event) => { event.stopPropagation(); void apply(candidate); }}>{t("applyCandidate")}</button>
          </div>
          {candidate.warnings?.map((warning) => <small className="warning-text" key={warning}>{translateMessage(warning)}</small>)}
        </article>;
      })}
    </div>}
    {focused && <div className="candidate-comparison" data-testid="candidate-comparison">
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
            const available = remote !== undefined;
            const chosen = selected.includes(field) && available;
            return <div className={`comparison-row ${chosen ? "selected" : ""}`} key={field}>
              <div className="comparison-value"><span>{t(field)}</span><strong>{displayValue(localFields[field], t("notProvided"), t("cover"))}</strong></div>
              <button className="transfer-button" disabled={!available} aria-label={t("transferField", { field: t(field) })} aria-pressed={chosen} title={t("transferField", { field: t(field) })} onClick={() => toggleField(field)}>{chosen ? "✓" : "→"}</button>
              <div className={`comparison-value remote ${available ? "" : "missing"}`}><span>{t(field)}</span><strong>{displayValue(remote, t("notProvided"), t("cover"))}</strong></div>
            </div>;
          })}
        </div>
        <div className="comparison-footer"><span>{t("selectedFieldCount", { count: availableSelected(focused).length })}</span><button disabled={availableSelected(focused).length === 0} onClick={() => void apply(focused)}>{t("applyCandidate")}</button></div>
      </>}
    </div>}
    {pendingCurrent && pending && <div role="dialog" className="confirm-dialog"><div className="dialog-body"><p>{t("reviewChanges")}</p>{pending.candidate.cover && <img className="candidate-cover" alt={t("candidateCover")} src={`data:${pending.candidate.cover.mimeType};base64,${pending.candidate.cover.data}`} />}{pending.confirmation.diff.map((entry) => <div key={entry.field}><strong>{t(entry.field as CandidateField)}</strong>: <del>{displayValue(entry.oldValue, t("notProvided"), t("cover"))}</del> <ins>{displayValue(entry.newValue, t("notProvided"), t("cover"))}</ins></div>)}<button onClick={() => void confirm(pending)} aria-label={t("confirmCandidateWrite")}>{t("confirmCandidateWrite")}</button><button onClick={() => setPending(undefined)}>{t("cancel")}</button></div></div>}
  </section>;
}
