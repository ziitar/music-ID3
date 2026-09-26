import { useEffect, useState } from "react";
import { CircleAlert, FolderOpen, LibraryBig, X } from "lucide-react";
import { DirectoryTree } from "./components/DirectoryTree";
import { LibraryList } from "./components/LibraryList";
import { MetadataPanel } from "./components/MetadataPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { OrganizerTray } from "./components/OrganizerTray";
import { editorStore, useEditorStore } from "./stores/editor-store";
import { libraryStore, useLibraryStore } from "./stores/library-store";
import { useI18n } from "./i18n";

export function App() {
  const { t, translateMessage } = useI18n();
  const root = useLibraryStore((state) => state.root);
  const scanRequestId = useLibraryStore((state) => state.requestId);
  const error = useEditorStore((state) => state.error);
  const [directoriesCollapsed, setDirectoriesCollapsed] = useState(false);
  useEffect(() => { if (root && scanRequestId) setDirectoriesCollapsed(true); }, [root, scanRequestId]);
  useEffect(() => {
    const onRoot = (event: Event) => { editorStore.setItem(undefined); void libraryStore.selectRoot((event as CustomEvent<string>).detail); };
    const onItem = (event: Event) => { const path = (event as CustomEvent<string>).detail; libraryStore.selectItem(path); const item = libraryStore.getState().items.find((entry) => entry.path === path); editorStore.setItem(item); };
    const onOverride = (event: Event) => { const path = (event as CustomEvent<string>).detail; void libraryStore.setWholeTrackOverride(path, true).then((accepted) => { if (!accepted || libraryStore.getState().selectedPath !== path) return; const item = libraryStore.getState().items.find((entry) => entry.path === path); if (item) editorStore.setItem(item); }); };
    const onCancel = () => libraryStore.cancelScan();
    window.addEventListener("music-id3:select-root", onRoot); window.addEventListener("music-id3:select-item", onItem); window.addEventListener("music-id3:override", onOverride); window.addEventListener("music-id3:cancel-scan", onCancel);
    return () => { window.removeEventListener("music-id3:select-root", onRoot); window.removeEventListener("music-id3:select-item", onItem); window.removeEventListener("music-id3:override", onOverride); window.removeEventListener("music-id3:cancel-scan", onCancel); };
  }, []);
  return <main className="app-shell"><header className="app-header"><div className="brand-lockup"><span className="brand-mark"><LibraryBig aria-hidden="true" /></span><div><h1>Music ID3</h1><span>{t("appTagline")}</span></div></div><div className="header-actions"><button className="primary-action" onClick={() => { editorStore.setItem(undefined); void libraryStore.selectRoot(); }}><FolderOpen aria-hidden="true" />{t("scanFolder")}</button><button className="secondary-action" onClick={() => window.dispatchEvent(new Event("music-id3:open-organizer"))}><LibraryBig aria-hidden="true" />{t("formatDirectory")}</button><SettingsPanel /></div></header><div className={`workspace ${directoriesCollapsed ? "directories-collapsed" : ""}`}><DirectoryTree collapsed={directoriesCollapsed} onToggle={() => setDirectoriesCollapsed((value) => !value)} /><LibraryList /><MetadataPanel /></div><OrganizerTray />{error && <div className="editor-error-toast" role="alert"><CircleAlert aria-hidden="true" /><span>{translateMessage(error)}</span><button className="icon-button" aria-label={t("dismissError")} onClick={() => editorStore.setError(undefined)}><X aria-hidden="true" /></button></div>}</main>;
}
