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
  it("invalidates the displayed audio diff when a selected draft value changes and rejects its stale confirmation", async () => {
    const writeAudio = vi.fn(async () => ({ ok: true as const, metadata: audio("D:/music/a.flac").metadata }));
    const store = createEditorStore({ writeAudio } as unknown as MusicId3Api);
    store.setItem(audio("D:/music/a.flac"));
    store.setField("title", "Previewed title");
    store.setFieldSelected("title", true);
    store.previewDiff();
    const confirmation = store.captureAudioWriteConfirmation();

    store.setField("title", "Unreviewed title");

    expect(store.getState().diff).toEqual([]);
    expect(store.captureAudioWriteConfirmation()).toBeUndefined();
    await expect(store.confirmAudioWrite(confirmation)).resolves.toBeUndefined();
    expect(writeAudio).not.toHaveBeenCalled();
  });

  it("consumes an audio preview token before awaiting so a repeated confirmation writes once", async () => {
    const write = deferred<Awaited<ReturnType<MusicId3Api["writeAudio"]>>>();
    const writeAudio = vi.fn(() => write.promise);
    const store = createEditorStore({ writeAudio } as unknown as MusicId3Api);
    store.setItem(audio("D:/music/a.flac"));
    store.setField("title", "Reviewed title");
    store.setFieldSelected("title", true);
    store.previewDiff();
    const confirmation = store.captureAudioWriteConfirmation();

    const first = store.confirmAudioWrite(confirmation);
    const duplicate = store.confirmAudioWrite(confirmation);

    expect(writeAudio).toHaveBeenCalledTimes(1);
    await expect(duplicate).resolves.toBeUndefined();
    write.resolve({ ok: true, metadata: { common: { title: "Reviewed title" }, raw: {}, durationMs: 1 } });
    await expect(first).resolves.toMatchObject({ ok: true });
  });

  it("normalizes a full provider release date to the writable year field", async () => {
    const candidate = { ...summary, date: "2026-09-04", confidence: "high" as const };
    const store = createEditorStore({ getMetadataCandidate: vi.fn(async () => candidate) } as unknown as MusicId3Api);
    store.setItem(audio("D:/music/a.flac"));

    await store.applyCandidate(summary, ["date"]);

    expect(store.getState()).toMatchObject({
      draft: { date: "2026" },
      diff: [{ field: "date", oldValue: undefined, newValue: "2026" }]
    });
  });

  it("passes local structural context into candidate search", async () => {
    const searchMetadata = vi.fn(async () => []);
    const store = createEditorStore({ searchMetadata } as unknown as MusicId3Api);
    store.setItem({
      ...audio("D:/music/a.flac"),
      durationMs: 245_000,
      metadata: { common: { title: "Song", artist: "Artist" }, raw: {}, durationMs: 245_000 }
    });

    await store.searchCandidates("musicbrainz", "Artist Song");

    expect(searchMetadata).toHaveBeenCalledWith("musicbrainz", "Artist Song", {
      title: "Song",
      artist: "Artist",
      durationMs: 245_000
    });
  });

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

    store.previewDiff();
    const confirmation = store.captureAudioWriteConfirmation();
    const pending = store.confirmAudioWrite(confirmation);
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

    store.previewDiff();
    const firstConfirmation = store.captureAudioWriteConfirmation();
    const first = store.confirmAudioWrite(firstConfirmation);
    store.setField("title", "Second");
    store.previewDiff();
    const secondConfirmation = store.captureAudioWriteConfirmation();
    const second = store.confirmAudioWrite(secondConfirmation);

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
    const input = (title: string): SaveCueInput => ({ path, encoding: "utf8", rawText: "", confirmationToken: `confirmation-${title}`, document: { title, remarks: [], files: [], tracks: [], unknownLines: [] } });

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

  it("rejects a repeated CUE confirmation token before invoking the bridge twice", async () => {
    const save = deferred<Awaited<ReturnType<MusicId3Api["saveCue"]>>>();
    const saveCue = vi.fn(() => save.promise);
    const store = createEditorStore({ saveCue } as unknown as MusicId3Api);
    const cuePath = "D:/same.cue";
    store.setItem({ kind: "cue", path: cuePath, encoding: "utf8", rawText: "", parsed: { remarks: [], files: [], tracks: [], unknownLines: [] }, referencedFiles: [], missingReferencedFiles: [] });
    const ownership = store.captureOwnership();
    const input = {
      path: cuePath,
      encoding: "utf8" as const,
      rawText: "",
      confirmationToken: "cue-confirmation-1",
      document: { remarks: [], files: [], tracks: [], unknownLines: [] }
    };

    const first = store.saveCueDraft(input, ownership);
    const duplicate = store.saveCueDraft(input, ownership);

    expect(saveCue).toHaveBeenCalledTimes(1);
    await expect(duplicate).resolves.toBeUndefined();
    save.resolve({ ok: true, path: cuePath, backupPath: `${cuePath}.bak` });
    await expect(first).resolves.toMatchObject({ ok: true });
  });
});
