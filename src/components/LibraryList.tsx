import { useEffect, useMemo, useState } from "react";
import type { LibraryItem } from "../../shared/types";
import { useLibraryStore } from "../stores/library-store";
import { useI18n } from "../i18n";

function duration(ms: number) { const sec = Math.round(ms / 1000); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`; }
function normalizedPath(value: string): string { return value.replaceAll("\\", "/").replace(/\/$/, ""); }
function itemFormat(item: LibraryItem): string { return item.kind === "audio" ? item.extension.toLocaleLowerCase() : ".cue"; }
function itemStatus(item: LibraryItem): string { return item.kind === "audio" ? item.wholeTrackStatus : item.parseError ? "error" : item.missingReferencedFiles.length ? "missing" : "normal"; }

export function LibraryList() {
  const { locale, t } = useI18n();
  const items = useLibraryStore((state) => state.items);
  const selected = useLibraryStore((state) => state.selectedPath);
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
  const select = (path: string) => window.dispatchEvent(new CustomEvent("music-id3:select-item", { detail: path }));
  const statusText = (item: LibraryItem) => {
    const value = itemStatus(item);
    if (locale === "en-US") return value === "missing" ? "missing CUE refs" : value;
    return value === "suspected" ? t("statusSuspected") : value === "overridden" ? t("statusOverridden") : value === "missing" ? t("statusMissing") : value === "error" ? t("statusError") : t("statusNormal");
  };
  return <section className="pane library-pane" aria-label={t("library")}>
    <div className="pane-toolbar"><h2>{t("library")}</h2><span data-testid="library-count">{t("itemCount", { count: visibleItems.length })}</span></div>
    <div className="library-filters">
      <input type="search" aria-label={t("librarySearch")} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("searchLibrary")} />
      <select aria-label={t("formatFilter")} value={format} onChange={(event) => setFormat(event.target.value)}><option value="">{t("allFormats")}</option>{formats.map((entry) => <option key={entry} value={entry}>{entry.slice(1).toUpperCase()}</option>)}</select>
      <select aria-label={t("statusFilter")} value={status} onChange={(event) => setStatus(event.target.value)}><option value="">{t("allStatuses")}</option><option value="normal">{t("statusNormal")}</option><option value="suspected">{t("statusSuspected")}</option><option value="overridden">{t("statusOverridden")}</option><option value="missing">{t("statusMissing")}</option><option value="error">{t("statusError")}</option></select>
    </div>
    <div className="library-list">{visibleItems.length === 0 ? <p className="empty-state">{items.length === 0 ? t("scanToBegin") : t("noFilesMatch")}</p> : visibleItems.map((item) => <button key={item.path} data-testid="library-row" className={`library-row ${selected === item.path ? "selected" : ""}`} onClick={() => select(item.path)}><span className="file-name">{item.kind === "audio" ? item.fileName : item.path.split(/[\\/]/).pop()}</span><span>{item.kind === "audio" ? item.extension.replace(".", "").toUpperCase() : "CUE"}</span><span>{item.kind === "audio" ? duration(item.durationMs) : "-"}</span><span>{item.kind === "audio" ? `${(item.sizeBytes / 1_000_000).toFixed(1)} MB` : "-"}</span><span className={`status status-${itemStatus(item)}`}>{statusText(item)}</span></button>)}</div>
  </section>;
}
