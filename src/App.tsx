import { useEffect } from "react";
import { DirectoryTree } from "./components/DirectoryTree";
import { LibraryList } from "./components/LibraryList";
import { MetadataPanel } from "./components/MetadataPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { editorStore } from "./stores/editor-store";
import { libraryStore } from "./stores/library-store";

export function App() {
  useEffect(() => {
    const onRoot = (event: Event) => { editorStore.setItem(undefined); void libraryStore.selectRoot((event as CustomEvent<string>).detail); };
    const onItem = (event: Event) => { const path = (event as CustomEvent<string>).detail; libraryStore.selectItem(path); const item = libraryStore.getState().items.find((entry) => entry.path === path); editorStore.setItem(item); };
    const onOverride = (event: Event) => { const path = (event as CustomEvent<string>).detail; libraryStore.setWholeTrackOverride(path, true); const item = libraryStore.getState().items.find((entry) => entry.path === path); editorStore.setItem(item); };
    const onCancel = () => libraryStore.cancelScan();
    window.addEventListener("music-id3:select-root", onRoot); window.addEventListener("music-id3:select-item", onItem); window.addEventListener("music-id3:override", onOverride); window.addEventListener("music-id3:cancel-scan", onCancel);
    return () => { window.removeEventListener("music-id3:select-root", onRoot); window.removeEventListener("music-id3:select-item", onItem); window.removeEventListener("music-id3:override", onOverride); window.removeEventListener("music-id3:cancel-scan", onCancel); };
  }, []);
  return <main className="app-shell"><header className="app-header"><h1>Music Library</h1><button className="scan-button" onClick={() => { editorStore.setItem(undefined); void libraryStore.selectRoot(); }}>Scan folder</button><SettingsPanel /></header><div className="workspace"><DirectoryTree /><LibraryList /><MetadataPanel /></div></main>;
}
