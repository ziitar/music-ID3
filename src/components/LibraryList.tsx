import { useEffect, useMemo, useState } from "react";
import { CheckSquare2, ListMusic, Search, SlidersHorizontal } from "lucide-react";
import type { LibraryItem } from "../../shared/types";
import { libraryStore, useLibraryStore } from "../stores/library-store";
import { useI18n } from "../i18n";

function duration(ms: number) { const sec = Math.round(ms / 1000); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`; }
function normalizedPath(value: string): string { return value.replaceAll("\\", "/").replace(/\/$/, ""); }
function itemFormat(item: LibraryItem): string { return item.kind === "audio" ? item.extension.toLocaleLowerCase() : ".cue"; }
function itemStatus(item: LibraryItem): string { return item.kind === "audio" ? item.wholeTrackStatus : item.parseError ? "error" : item.missingReferencedFiles.length ? "missing" : "normal"; }
function canOrganize(item: LibraryItem): item is Extract<LibraryItem, { kind: "audio" }> {
  if (item.kind !== "audio" || item.wholeTrackStatus === "suspected" || item.cuePath) return false;
  const metadata = item.metadata.common;
  return Boolean(metadata.title && metadata.album && (metadata.albumArtist || metadata.artist));
}

export function LibraryList() {
  const { locale, t } = useI18n();
  const items = useLibraryStore((state) => state.items);
  const selected = useLibraryStore((state) => state.selectedPath);
  const organizeSelection = useLibraryStore((state) => state.organizeSelection);
  const root = useLibraryStore((state) => state.root);
  const currentDirectory = useLibraryStore((state) => state.currentDirectory);
  const [query, setQuery] = useState("");
  const [format, setFormat] = useState("");
  const [status, setStatus] = useState("");
  useEffect(() => { setQuery(""); setFormat(""); setStatus(""); }, [root]);
  const formats = useMemo(() => [...new Set(items.map(itemFormat))].sort(), [items]);
  const visibleItems = items.filter((item) => {
    const normalizedItemPath = normalizedPath(item.path);
    const inDirectory = !currentDirectory || normalizedItemPath.toLocaleLowerCase().startsWith(`${normalizedPath(currentDirectory).toLocaleLowerCase()}/`);
    const matchesQuery = !query.trim() || normalizedItemPath.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
    return inDirectory && matchesQuery && (!format || itemFormat(item) === format) && (!status || itemStatus(item) === status);
  });
  const organizablePaths = visibleItems.filter(canOrganize).map((item) => item.path);
  const allOrganizableSelected = organizablePaths.length > 0 && organizablePaths.every((path) => organizeSelection.includes(path));
  const select = (path: string) => window.dispatchEvent(new CustomEvent("music-id3:select-item", { detail: path }));
  const statusText = (item: LibraryItem) => {
    const value = itemStatus(item);
    if (locale === "en-US") return value === "missing" ? "missing CUE refs" : value;
    return value === "suspected" ? t("statusSuspected") : value === "overridden" ? t("statusOverridden") : value === "missing" ? t("statusMissing") : value === "error" ? t("statusError") : t("statusNormal");
  };
  const toggleAll = () => {
    const remaining = organizeSelection.filter((path) => !organizablePaths.includes(path));
    libraryStore.setOrganizeSelection(allOrganizableSelected ? remaining : [...remaining, ...organizablePaths]);
  };
  return <section className="pane library-pane" aria-label={t("library")}>
    <div className="pane-toolbar"><div><ListMusic aria-hidden="true" /><h2>{t("library")}</h2></div><span data-testid="library-count">{t("itemCount", { count: visibleItems.length })}</span></div>
    <div className="library-filters">
      <label className="search-control"><Search aria-hidden="true" /><input type="search" aria-label={t("librarySearch")} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("searchLibrary")} /></label>
      <label className="select-control"><SlidersHorizontal aria-hidden="true" /><select aria-label={t("formatFilter")} value={format} onChange={(event) => setFormat(event.target.value)}><option value="">{t("allFormats")}</option>{formats.map((entry) => <option key={entry} value={entry}>{entry.slice(1).toUpperCase()}</option>)}</select></label>
      <select aria-label={t("statusFilter")} value={status} onChange={(event) => setStatus(event.target.value)}><option value="">{t("allStatuses")}</option><option value="normal">{t("statusNormal")}</option><option value="suspected">{t("statusSuspected")}</option><option value="overridden">{t("statusOverridden")}</option><option value="missing">{t("statusMissing")}</option><option value="error">{t("statusError")}</option></select>
    </div>
    <div className="library-list-header"><label title={t("selectReadyTracks")}><input type="checkbox" aria-label={t("selectReadyTracks")} checked={allOrganizableSelected} disabled={!organizablePaths.length} onChange={toggleAll} /><CheckSquare2 aria-hidden="true" /></label><span>{t("trackColumn")}</span><span>{t("formatColumn")}</span><span>{t("statusColumn")}</span></div>
    <div className="library-list">{visibleItems.length === 0 ? <p className="empty-state">{items.length === 0 ? t("scanToBegin") : t("noFilesMatch")}</p> : visibleItems.map((item) => {
      const common = item.kind === "audio" ? item.metadata.common : undefined;
      const organizable = canOrganize(item);
      const itemName = item.kind === "audio" ? item.fileName : item.path.split(/[\\/]/).pop() ?? item.path;
      return <article key={item.path} data-testid="library-row" className={`library-row ${selected === item.path ? "selected" : ""}`}>
        <label className="row-check" title={organizable ? t("selectForOrganization") : t("metadataRequiredForPath")}><input type="checkbox" aria-label={t("selectTrackForOrganization", { name: itemName })} checked={organizeSelection.includes(item.path)} disabled={!organizable} onChange={(event) => libraryStore.toggleOrganizeSelection(item.path, event.target.checked)} /><span /></label>
        <button className="library-row-main" onClick={() => select(item.path)}>
          <span className="track-copy"><strong className="file-name">{itemName}</strong>{common && <small><span>{common.title || t("notProvided")}</span><span>{[common.artist, common.album].filter(Boolean).join(" · ")}</span></small>}</span>
          <span className="format-copy"><strong>{item.kind === "audio" ? item.extension.replace(".", "").toUpperCase() : "CUE"}</strong><small>{item.kind === "audio" ? duration(item.durationMs) : "-"}</small></span>
          <span className={`status status-${itemStatus(item)}`}>{statusText(item)}</span>
        </button>
      </article>;
    })}</div>
  </section>;
}
