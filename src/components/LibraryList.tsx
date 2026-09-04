import { useEffect, useMemo, useState } from "react";
import type { LibraryItem } from "../../shared/types";
import { useLibraryStore } from "../stores/library-store";

function duration(ms: number) { const sec = Math.round(ms / 1000); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`; }
function normalizedPath(value: string): string { return value.replaceAll("\\", "/").replace(/\/$/, ""); }
function itemFormat(item: LibraryItem): string { return item.kind === "audio" ? item.extension.toLocaleLowerCase() : ".cue"; }
function itemStatus(item: LibraryItem): string { return item.kind === "audio" ? item.wholeTrackStatus : item.parseError ? "error" : item.missingReferencedFiles.length ? "missing" : "normal"; }

export function LibraryList() {
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
  return <section className="pane library-pane" aria-label="Library">
    <div className="pane-toolbar"><h2>Library</h2><span data-testid="library-count">{visibleItems.length} items</span></div>
    <div className="library-filters">
      <input type="search" aria-label="Library search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search library" />
      <select aria-label="Format filter" value={format} onChange={(event) => setFormat(event.target.value)}><option value="">All formats</option>{formats.map((entry) => <option key={entry} value={entry}>{entry.slice(1).toUpperCase()}</option>)}</select>
      <select aria-label="Status filter" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All statuses</option><option value="normal">Normal</option><option value="suspected">Suspected</option><option value="overridden">Overridden</option><option value="missing">Missing CUE refs</option><option value="error">Error</option></select>
    </div>
    <div className="library-list">{visibleItems.length === 0 ? <p className="empty-state">{items.length === 0 ? "Scan a folder to begin." : "No files match this view."}</p> : visibleItems.map((item) => <button key={item.path} data-testid="library-row" className={`library-row ${selected === item.path ? "selected" : ""}`} onClick={() => select(item.path)}><span className="file-name">{item.kind === "audio" ? item.fileName : item.path.split(/[\\/]/).pop()}</span><span>{item.kind === "audio" ? item.extension.replace(".", "").toUpperCase() : "CUE"}</span><span>{item.kind === "audio" ? duration(item.durationMs) : "-"}</span><span>{item.kind === "audio" ? `${(item.sizeBytes / 1_000_000).toFixed(1)} MB` : "-"}</span><span className={`status status-${itemStatus(item)}`}>{item.kind === "audio" ? item.wholeTrackStatus : item.missingReferencedFiles.length ? "missing CUE refs" : item.parseError ? "error" : "normal"}</span></button>)}</div>
  </section>;
}
