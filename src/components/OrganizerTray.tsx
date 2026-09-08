import { useEffect, useRef, useState } from "react";
import { Check, FolderOpen, LibraryBig, LoaderCircle, MoveRight, X } from "lucide-react";
import type { OrganizePlan } from "../../shared/types";
import { useI18n } from "../i18n";
import { editorStore } from "../stores/editor-store";
import { libraryStore, useLibraryStore } from "../stores/library-store";

function fileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

function pathPreview(item: ReturnType<typeof libraryStore.getState>["items"][number] | undefined): string {
  if (item?.kind !== "audio") return "";
  const metadata = item.metadata.common;
  const artist = metadata.albumArtist || metadata.artist;
  if (!artist || !metadata.album || !metadata.title) return "";
  return [artist, metadata.album, `${metadata.title}${item.extension.toLocaleLowerCase()}`].join(" / ");
}

export function OrganizerTray() {
  const { t, translateMessage } = useI18n();
  const items = useLibraryStore((state) => state.items);
  const selection = useLibraryStore((state) => state.organizeSelection);
  const [targetRoot, setTargetRoot] = useState("");
  const [plan, setPlan] = useState<OrganizePlan>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const trayRef = useRef<HTMLElement>(null);
  const firstSelected = items.find((item) => selection.includes(item.path));
  const preview = pathPreview(firstSelected);

  useEffect(() => {
    setPlan(undefined);
  }, [selection.join("\0"), targetRoot]);

  const chooseTarget = async () => {
    setMessage(undefined);
    try {
      const selected = await window.musicId3.selectOrganizeDirectory();
      if (selected) setTargetRoot(selected);
    } catch {
      setMessage("Unable to select organize target");
    }
  };

  useEffect(() => {
    const open = () => {
      trayRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      if (!targetRoot) void chooseTarget();
    };
    window.addEventListener("music-id3:open-organizer", open);
    return () => window.removeEventListener("music-id3:open-organizer", open);
  }, [targetRoot]);

  const prepare = async () => {
    if (!selection.length || !targetRoot) return;
    setBusy(true);
    setMessage(undefined);
    try {
      setPlan(await window.musicId3.prepareLibraryOrganization(selection, targetRoot));
    } catch {
      setMessage("Unable to preview library organization");
    } finally {
      setBusy(false);
    }
  };

  const execute = async () => {
    if (!plan || plan.entries.some((entry) => entry.status === "blocked")) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await window.musicId3.executeLibraryOrganization(plan.confirmationToken);
      if (!result.ok) {
        setMessage(result.rolledBack ? result.error : `${result.error}. ${t("organizeRollbackFailed")}`);
        return;
      }
      libraryStore.applyOrganizeMoves(result.moved);
      const selectedPath = libraryStore.getState().selectedPath;
      editorStore.setItem(selectedPath ? libraryStore.getState().items.find((item) => item.path === selectedPath) : undefined);
      setPlan(undefined);
      setMessage(t("organizedCount", { count: result.moved.length }));
    } catch {
      setMessage("Unable to organize selected files");
    } finally {
      setBusy(false);
    }
  };

  const blocked = plan?.entries.some((entry) => entry.status === "blocked") ?? false;
  return <>
    <section className="organizer-tray" ref={trayRef} aria-label={t("formatDirectory")}>
      <div className="organizer-title"><LibraryBig aria-hidden="true" /><div><strong>{t("formatDirectory")}</strong><span>{t("organizeSelectionCount", { count: selection.length })}</span></div></div>
      <button className="path-picker" onClick={() => void chooseTarget()} aria-label={t("chooseTargetRoot")}>
        <FolderOpen aria-hidden="true" /><span><small>{t("targetRoot")}</small><strong>{targetRoot || t("chooseTargetRoot")}</strong></span>
      </button>
      <div className="path-preview"><small>{t("pathPreview")}</small><strong>{preview || t("metadataRequiredForPath")}</strong></div>
      <button className="primary-action" disabled={!selection.length || !targetRoot || busy} onClick={() => void prepare()}>
        {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <MoveRight aria-hidden="true" />}{t("previewOrganization")}
      </button>
      {message && <span className="tray-message" role="status">{translateMessage(message)}</span>}
    </section>
    {plan && <div className="dialog-backdrop" role="presentation">
      <section role="dialog" aria-modal="true" aria-labelledby="organize-dialog-title" className="organize-dialog">
        <header><div><h2 id="organize-dialog-title">{t("confirmOrganization")}</h2><p>{t("organizationDestination", { path: plan.targetRoot })}</p></div><button className="icon-button" aria-label={t("close")} onClick={() => setPlan(undefined)}><X aria-hidden="true" /></button></header>
        <div className="organize-plan-list">
          {plan.entries.map((entry) => <article className={`organize-plan-row organize-${entry.status}`} key={entry.sourcePath}>
            <span className="plan-state">{entry.status === "ready" ? <MoveRight aria-hidden="true" /> : entry.status === "unchanged" ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}</span>
            <div><strong>{fileName(entry.sourcePath)}</strong><span>{entry.relativePath ?? translateMessage(entry.reason ?? "")}</span>{entry.reason && entry.relativePath && <small>{translateMessage(entry.reason)}</small>}</div>
          </article>)}
        </div>
        {blocked && <p className="error-text" role="alert">{t("resolveOrganizationIssues")}</p>}
        <footer><button className="secondary-action" onClick={() => setPlan(undefined)}>{t("cancel")}</button><button className="primary-action" disabled={blocked || busy} onClick={() => void execute()}>{busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <Check aria-hidden="true" />}{t("confirmMoveCount", { count: plan.readyCount })}</button></footer>
      </section>
    </div>}
  </>;
}
