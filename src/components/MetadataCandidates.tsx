import { useState } from "react";
import { editorStore, useEditorStore } from "../stores/editor-store";
import { libraryStore } from "../stores/library-store";
import type { MetadataCandidate, MetadataSource } from "../../shared/types";

const candidateFields = ["title", "artist", "album", "date", "cover"] as const;

export function MetadataCandidates() {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<MetadataSource>("musicbrainz");
  const [selected, setSelected] = useState<string[]>(["title", "artist", "album"]);
  const [pending, setPending] = useState<MetadataCandidate>();
  const state = useEditorStore((value) => value);
  const apply = async (candidate: MetadataCandidate) => {
    const item = editorStore.getState().item;
    const result = await editorStore.applyCandidate(candidate, selected);
    if (item?.kind === "audio" && item.wholeTrackStatus !== "suspected" && result) setPending(result.candidate);
  };
  const confirm = async () => {
    const item = editorStore.getState().item;
    const result = await editorStore.confirmAudioWrite();
    if (!result?.ok) return;
    if (item?.kind === "audio") {
      const metadata = await libraryStore.refreshItem(item.path);
      const refreshed = libraryStore.getState().items.find((entry) => entry.path === item.path);
      if (metadata && refreshed) editorStore.setItem(refreshed);
    }
    setPending(undefined);
  };
  return <div className="candidate-panel">
    <h3>Metadata candidates</h3>
    <div className="candidate-search"><select aria-label="provider" value={source} onChange={(event) => setSource(event.target.value as MetadataSource)}><option value="musicbrainz">MusicBrainz</option><option value="netease">NetEase</option><option value="qq">QQ Music</option><option value="ctdb">CTDB</option></select><input aria-label="candidate query" value={query} onChange={(event) => setQuery(event.target.value)} /><button disabled={!query.trim() || state.searching} onClick={() => editorStore.searchCandidates(source, query)}>Search</button></div>
    {state.searching && <p role="status">Searching...</p>}{state.searchCompleted && state.candidates.length === 0 && !state.error && <p className="empty-state">No candidates found.</p>}
    {state.candidates.map((candidate) => <div className="candidate-row" key={`${candidate.source}-${candidate.id}`}><div><strong>{candidate.title}</strong><span>{candidate.artist ?? "Unknown artist"}</span><small>{[candidate.album, candidate.date, candidate.format, candidate.country].filter(Boolean).join(" · ")}</small></div>{candidate.cover && <img className="candidate-cover" alt="candidate cover" src={`data:${candidate.cover.mimeType};base64,${candidate.cover.data}`} />}<span className={`confidence confidence-${candidate.confidence}`}>{candidate.confidence}</span><div className="candidate-fields">{candidateFields.map((field) => { const available = field === "title" || candidate[field] !== undefined; return <label key={field}><input type="checkbox" checked={available && selected.includes(field)} disabled={!available} onChange={(event) => setSelected((current) => event.target.checked ? [...new Set([...current, field])] : current.filter((entry) => entry !== field))} />{field}</label>; })}</div><button disabled={selected.length === 0} onClick={() => apply(candidate)}>Apply candidate</button></div>)}
    {pending && <div role="dialog" className="confirm-dialog"><div className="dialog-body"><p>Review selected changes before writing.</p>{pending.cover && <img className="candidate-cover" alt="candidate cover" src={`data:${pending.cover.mimeType};base64,${pending.cover.data}`} />}{editorStore.getState().diff.map((entry) => <div key={entry.field}><strong>{entry.field}</strong>: <del>{String(entry.oldValue ?? "")}</del> <ins>{String(entry.newValue ?? "")}</ins></div>)}<button onClick={confirm} aria-label="confirm candidate write">Confirm candidate write</button><button onClick={() => setPending(undefined)}>Cancel</button></div></div>}
  </div>;
}
