import { describe, expect, it, vi } from "vitest";
import type { MusicId3Api } from "../../shared/ipc";
import type { LibraryItem, MetadataCandidate, SaveCueInput } from "../../shared/types";
import { createEditorStore } from "../../src/stores/editor-store";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function audio(path: string, wholeTrackStatus: "normal" | "suspected" = "normal"): Extract<LibraryItem, { kind: "audio" }> {
  const fileName = path.split("/").pop() ?? path;
  return {
    kind: "audio",
    path,
    fileName,
    extension: ".flac",
    sizeBytes: 1,
    durationMs: 1,
    metadata: { common: { title: `${fileName} title` }, raw: {}, durationMs: 1 },
    wholeTrackStatus
  };
}

const summary: MetadataCandidate = {
  id: "release",
  source: "musicbrainz",
  title: "Summary",
  confidence: "low"
};

describe("editor store async ownership", () => {
  it("does not apply audio candidate details after selection moves to another item", async () => {
    const details = deferred<MetadataCandidate>();
    const writeAudio = vi.fn();
    const api = {
      getMetadataCandidate: vi.fn(() => details.promise),
      writeAudio
    } as unknown as MusicId3Api;
    const store = createEditorStore(api);
    store.setItem(audio("D:/music/a.flac"));

    const applying = store.applyCandidate(summary, ["title"]);
    store.setItem(audio("D:/music/b.flac"));
    details.resolve({ ...summary, title: "Resolved A", confidence: "high" });
    await applying;

    expect(store.getState()).toMatchObject({
      item: { path: "D:/music/b.flac" },
      draft: { title: "b.flac title" },
      selectedFields: [],
      diff: []
    });
    expect(store.getState().cueDraft).toBeUndefined();
    expect(writeAudio).not.toHaveBeenCalled();
  });

  it("does not install a suspected audio CUE draft after selection moves to another item", async () => {
    const cue = deferred<Awaited<ReturnType<MusicId3Api["buildCandidateCue"]>>>();
    const detailed = { ...summary, offsets: [150], tracks: [{ number: 1, title: "One" }], confidence: "high" as const };
    const api = {
      getMetadataCandidate: vi.fn(async () => detailed),
      buildCandidateCue: vi.fn(() => cue.promise)
    } as unknown as MusicId3Api;
    const store = createEditorStore(api);
    store.setItem(audio("D:/music/a.flac", "suspected"));

    const applying = store.applyCandidate(summary, ["title"]);
    await vi.waitFor(() => expect(api.buildCandidateCue).toHaveBeenCalled());
    store.setItem(audio("D:/music/b.flac"));
    cue.resolve({ title: "Resolved A", remarks: [], files: [{ path: "a.flac" }], tracks: [{ number: 1, indexes: [{ number: 1, time: "00:00:00" }] }], unknownLines: [] });
    await applying;

    expect(store.getState()).toMatchObject({ item: { path: "D:/music/b.flac" }, draft: { title: "b.flac title" } });
    expect(store.getState().cueDraft).toBeUndefined();
  });

  it("does not install search results after selection moves to another item", async () => {
    let resolveSearch!: (value: MetadataCandidate[]) => void;
    const search = new Promise<MetadataCandidate[]>((resolve) => { resolveSearch = resolve; });
    const api = { searchMetadata: vi.fn(() => search) } as unknown as MusicId3Api;
    const store = createEditorStore(api);
    store.setItem(audio("D:/A.flac", "A"));

    const pending = store.searchCandidates("musicbrainz", "A");
    store.setItem(audio("D:/B.flac", "B"));
    resolveSearch([{ id: "a", source: "musicbrainz", title: "A result", confidence: "high" }]);
    await pending;

    expect(store.getState()).toMatchObject({ item: { path: "D:/B.flac" }, candidates: [], searching: false, searchCompleted: false });
  });

  it("keeps only the newest overlapping candidate search results", async () => {
    const resolvers: Array<(value: MetadataCandidate[]) => void> = [];
    const api = { searchMetadata: vi.fn(() => new Promise<MetadataCandidate[]>((resolve) => resolvers.push(resolve))) } as unknown as MusicId3Api;
    const store = createEditorStore(api);
    store.setItem(audio("D:/A.flac", "A"));

    const first = store.searchCandidates("musicbrainz", "first");
    const second = store.searchCandidates("musicbrainz", "second");
    resolvers[1]([{ id: "new", source: "musicbrainz", title: "New", confidence: "high" }]);
    await second;
    resolvers[0]([{ id: "old", source: "musicbrainz", title: "Old", confidence: "high" }]);
    await first;

    expect(store.getState().candidates.map((candidate) => candidate.id)).toEqual(["new"]);
  });

  it("does not replace the current editor when a confirmed write for the prior item completes", async () => {
    const write = deferred<Awaited<ReturnType<MusicId3Api["writeAudio"]>>>();
    const api = { writeAudio: vi.fn(() => write.promise) } as unknown as MusicId3Api;
    const store = createEditorStore(api);
    store.setItem(audio("D:/A.flac")); store.setField("title", "Written A"); store.setFieldSelected("title", true);

    const pending = store.confirmAudioWrite();
    store.setItem(audio("D:/B.flac"));
    write.resolve({ ok: true, metadata: { common: { title: "Written A" }, raw: {}, durationMs: 1 } });

    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(store.getState()).toMatchObject({ item: { path: "D:/B.flac", metadata: { common: { title: "B.flac title" } } }, draft: { title: "B.flac title" }, selectedFields: [] });
  });

  it("rejects a detailed candidate when no selected usable fields remain", async () => {
    const writeAudio = vi.fn();
    const api = { getMetadataCandidate: vi.fn(async () => ({ ...summary, cover: undefined })), writeAudio } as unknown as MusicId3Api;
    const store = createEditorStore(api); store.setItem(audio("D:/A.flac"));

    await expect(store.applyCandidate(summary, ["cover"])).resolves.toBeUndefined();

    expect(store.getState()).toMatchObject({ selectedFields: [], diff: [], error: "No applicable candidate fields selected" });
    expect(writeAudio).not.toHaveBeenCalled();
  });

  it("applies an already loaded detailed candidate without fetching it again", async () => {
    const cover = { mimeType: "image/jpeg", data: "AQID" };
    const getMetadataCandidate = vi.fn();
    const store = createEditorStore({ getMetadataCandidate } as unknown as MusicId3Api); store.setItem(audio("D:/A.flac"));
    const detailed = { ...summary, title: "Detailed", cover, confidence: "high" as const };

    await expect(store.applyCandidate(detailed, ["cover"], true)).resolves.toMatchObject({ candidate: detailed });

    expect(getMetadataCandidate).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({ draft: { cover }, selectedFields: ["cover"] });
  });

  it("serializes writes for one path and only applies the latest initiated result", async () => {
    const writes = [
      deferred<Awaited<ReturnType<MusicId3Api["writeAudio"]>>>(),
      deferred<Awaited<ReturnType<MusicId3Api["writeAudio"]>>>()
    ];
    const writeAudio = vi.fn()
      .mockImplementationOnce(() => writes[0].promise)
      .mockImplementationOnce(() => writes[1].promise);
    const store = createEditorStore({ writeAudio } as unknown as MusicId3Api);
    store.setItem(audio("D:/same.flac"));
    store.setField("title", "First");
    store.setFieldSelected("title", true);

    const first = store.confirmAudioWrite();
    store.setField("title", "Second");
    const second = store.confirmAudioWrite();

    expect(writeAudio).toHaveBeenCalledTimes(1);
    writes[0].resolve({ ok: true, metadata: { common: { title: "First on disk" }, raw: {}, durationMs: 1 } });
    await first;
    expect(store.getState().item).toMatchObject({ metadata: { common: { title: "same.flac title" } } });
    await vi.waitFor(() => expect(writeAudio).toHaveBeenCalledTimes(2));
    expect(writeAudio.mock.calls[1][1]).toMatchObject({ fields: { title: "Second" } });

    writes[1].resolve({ ok: true, metadata: { common: { title: "Second on disk" }, raw: {}, durationMs: 1 } });
    await second;
    expect(store.getState().item).toMatchObject({ metadata: { common: { title: "Second on disk" } } });
  });

  it("serializes CUE saves for one path and ignores an older save error", async () => {
    const saves = [
      deferred<Awaited<ReturnType<MusicId3Api["saveCue"]>>>(),
      deferred<Awaited<ReturnType<MusicId3Api["saveCue"]>>>()
    ];
    const saveCue = vi.fn()
      .mockImplementationOnce(() => saves[0].promise)
      .mockImplementationOnce(() => saves[1].promise);
    const store = createEditorStore({ saveCue } as unknown as MusicId3Api);
    const path = "D:/same.cue";
    store.setItem({ kind: "cue", path, encoding: "utf8", rawText: "", parsed: { remarks: [], files: [], tracks: [], unknownLines: [] }, referencedFiles: [], missingReferencedFiles: [] });
    const ownership = store.captureOwnership();
    const input = (title: string): SaveCueInput => ({ path, encoding: "utf8", rawText: "", document: { title, remarks: [], files: [], tracks: [], unknownLines: [] } });

    const first = store.saveCueDraft(input("First"), ownership);
    const second = store.saveCueDraft(input("Second"), ownership);

    expect(saveCue).toHaveBeenCalledTimes(1);
    saves[0].resolve({ ok: false, error: "stale failure" });
    await expect(first).resolves.toMatchObject({ ok: false, latest: false });
    expect(store.getState().error).toBeUndefined();
    await vi.waitFor(() => expect(saveCue).toHaveBeenCalledTimes(2));
    expect(saveCue.mock.calls[1][0]).toMatchObject({ document: { title: "Second" } });
    saves[1].resolve({ ok: true, path, backupPath: `${path}.bak` });
    await expect(second).resolves.toMatchObject({ ok: true, latest: true });
  });
});
