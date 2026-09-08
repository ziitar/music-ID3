import { editorStore } from "../stores/editor-store";
import { libraryStore, useLibraryStore } from "../stores/library-store";
import { useI18n } from "../i18n";

type DirectoryNode = { name: string; path: string; children: DirectoryNode[] };

function normalizedPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/$/, "");
}

function directoryNodes(root: string, paths: string[]): DirectoryNode[] {
  const normalizedRoot = normalizedPath(root);
  const roots: DirectoryNode[] = [];
  const byPath = new Map<string, DirectoryNode>();
  for (const itemPath of paths) {
    const parent = normalizedPath(itemPath).split("/").slice(0, -1).join("/");
    if (!parent.toLocaleLowerCase().startsWith(`${normalizedRoot.toLocaleLowerCase()}/`)) continue;
    const segments = parent.slice(normalizedRoot.length + 1).split("/").filter(Boolean);
    let currentPath = normalizedRoot;
    let children = roots;
    for (const segment of segments) {
      currentPath = `${currentPath}/${segment}`;
      let node = byPath.get(currentPath.toLocaleLowerCase());
      if (!node) {
        node = { name: segment, path: currentPath, children: [] };
        byPath.set(currentPath.toLocaleLowerCase(), node);
        children.push(node);
        children.sort((left, right) => left.name.localeCompare(right.name));
      }
      children = node.children;
    }
  }
  return roots;
}

function DirectoryBranch({ nodes, selected, select }: { nodes: DirectoryNode[]; selected?: string; select: (path: string) => void }) {
  return <ul className="directory-children">{nodes.map((node) => <li key={node.path}>
    <button aria-pressed={selected === node.path} onClick={() => select(node.path)}><Folder aria-hidden="true" /><span>{node.name}</span></button>
    {node.children.length > 0 && <DirectoryBranch nodes={node.children} selected={selected} select={select} />}
  </li>)}</ul>;
}

export function DirectoryTree() {
  const { t, translateMessage } = useI18n();
  const root = useLibraryStore((state) => state.root);
  const items = useLibraryStore((state) => state.items);
  const currentDirectory = useLibraryStore((state) => state.currentDirectory);
  const scanning = useLibraryStore((state) => state.scanning);
  const error = useLibraryStore((state) => state.error);
  const select = (directory?: string) => { editorStore.setItem(undefined); libraryStore.setCurrentDirectory(directory); };
  const nodes = root ? directoryNodes(root, items.map((item) => item.path)) : [];
  return <aside className="pane directory-pane" aria-label={t("directories")}>
    <div className="pane-toolbar"><div><FolderTree aria-hidden="true" /><h2>{t("directories")}</h2></div></div>
    <button className="directory-picker secondary-action" onClick={() => { editorStore.setItem(undefined); void libraryStore.selectRoot(); }}><FolderOpen aria-hidden="true" />{t("chooseFolder")}</button>
    <div className="directory-root" data-testid="directory-root">{root ?? t("noFolderSelected")}</div>
    {root && <nav aria-label={t("libraryDirectories")}><button aria-pressed={!currentDirectory} onClick={() => select(undefined)}><LibraryBig aria-hidden="true" /><span>{t("allFiles")}</span><small>{items.length}</small></button><DirectoryBranch nodes={nodes} selected={currentDirectory} select={select} /></nav>}
    {scanning && <div role="status" className="scan-status" data-testid="scan-progress"><LoaderCircle className="spin" aria-hidden="true" /><span>{t("scanning")}</span><button className="icon-button" aria-label={t("cancel")} onClick={() => window.dispatchEvent(new Event("music-id3:cancel-scan"))}><X aria-hidden="true" /></button></div>}
    {error && <p className="error-text">{translateMessage(error)}</p>}
  </aside>;
}
import { Folder, FolderOpen, FolderTree, LibraryBig, LoaderCircle, X } from "lucide-react";
