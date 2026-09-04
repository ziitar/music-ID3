import { describe, expect, it, vi } from "vitest";
import type { MusicId3Api } from "../../shared/ipc";
import type { LibraryItem, MetadataCandidate } from "../../shared/types";
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
});
