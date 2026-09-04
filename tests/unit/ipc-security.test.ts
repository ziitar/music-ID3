import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerIpcHandlers } from "../../electron/ipc/register-ipc";
import { ipcChannels } from "../../shared/ipc";
import type { LibraryItem } from "../../shared/types";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function sender(id: number) {
  let destroyed: (() => void) | undefined;
  return {
    id,
    send: vi.fn(),
    once: vi.fn((event: string, listener: () => void) => { if (event === "destroyed") destroyed = listener; }),
    destroy: () => destroyed?.()
  };
}

function register(options: Record<string, unknown> = {}) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  registerIpcHandlers({
    ipcMain: { handle(channel, listener) { handlers.set(channel, listener); } },
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    cookieStore: { set: async () => undefined, redacted: async () => "unconfigured" },
    ...options
  });
  return handlers;
}

function event(current: ReturnType<typeof sender>) {
  return { sender: current };
}

describe("sender-scoped IPC path authorization", () => {
  it("authorizes a canonical root only for the renderer that selected it and clears ownership on destruction", async () => {
    const root = await temporaryDirectory("music-id3-authorized-");
    const first = sender(1);
    const second = sender(2);
    const handlers = register({ showOpenDialog: async () => ({ canceled: false, filePaths: [root] }), scanLibrary: async () => ({ items: [], errors: [] }) });

    await expect(Promise.resolve().then(() => handlers.get(ipcChannels.scanDirectory)?.(event(first), root, "before-select"))).rejects.toThrow(/select.*directory/i);
    await expect(handlers.get(ipcChannels.selectDirectory)?.(event(first))).resolves.toBe(root);
    await expect(Promise.resolve().then(() => handlers.get(ipcChannels.scanDirectory)?.(event(second), root, "other-renderer"))).rejects.toThrow(/select.*directory/i);
    await expect(handlers.get(ipcChannels.scanDirectory)?.(event(first), root, "owned")).resolves.toMatchObject({ ok: true });

    first.destroy();
    await expect(Promise.resolve().then(() => handlers.get(ipcChannels.scanDirectory)?.(event(first), root, "destroyed"))).rejects.toThrow(/select.*directory/i);
  });

  it("rejects canonical junction escapes and paths with the wrong capability extension", async () => {
    const root = await temporaryDirectory("music-id3-root-");
    const outside = await temporaryDirectory("music-id3-outside-");
    const outsideCue = path.join(outside, "outside.cue");
    await writeFile(outsideCue, 'FILE "disc.flac" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00');
    const junction = path.join(root, "escape");
    await symlink(outside, junction, "junction");
    const notes = path.join(root, "notes.txt");
    await writeFile(notes, "not audio");
    const owner = sender(7);
    const handlers = register({ showOpenDialog: async () => ({ canceled: false, filePaths: [root] }) });
    await handlers.get(ipcChannels.selectDirectory)?.(event(owner));

    await expect(handlers.get(ipcChannels.readCue)?.(event(owner), path.join(junction, "outside.cue"))).rejects.toThrow(/outside.*selected directory/i);
    await expect(handlers.get(ipcChannels.readAudio)?.(event(owner), notes)).rejects.toThrow(/supported audio/i);
    await expect(handlers.get(ipcChannels.saveCue)?.(event(owner), { path: path.join(root, "not-a-cue.txt"), rawText: "", encoding: "utf8", confirmationToken: "wrong-extension", document: {} })).rejects.toThrow(/\.cue/i);
  });

  it("enforces suspected whole-track state in main until an explicit sender-owned override", async () => {
    const root = await temporaryDirectory("music-id3-suspected-");
    const audioPath = path.join(root, "disc.mp3");
    await writeFile(audioPath, "fixture");
    const item: Extract<LibraryItem, { kind: "audio" }> = {
      kind: "audio",
      path: audioPath,
      fileName: "disc.mp3",
      extension: ".mp3",
      sizeBytes: 7,
      durationMs: 901_000,
      metadata: { common: {}, raw: {}, durationMs: 901_000 },
      wholeTrackStatus: "suspected"
    };
    const writeAudio = vi.fn(async () => ({ ok: true as const, metadata: item.metadata }));
    const owner = sender(12);
    let scanComplete!: () => void;
    const completed = new Promise<void>((resolve) => { scanComplete = resolve; });
    owner.send.mockImplementation((_channel, payload) => { if ((payload as { phase: string }).phase === "complete") scanComplete(); });
    const handlers = register({
      showOpenDialog: async () => ({ canceled: false, filePaths: [root] }),
      scanLibrary: async (_root: string, onItem: (value: LibraryItem) => void) => { onItem(item); return { items: [item], errors: [] }; },
      writeAudio
    });
    await handlers.get(ipcChannels.selectDirectory)?.(event(owner));
    await handlers.get(ipcChannels.scanDirectory)?.(event(owner), root, "scan");
    await completed;
    const patch = { fields: { title: "Unsafe" }, selectedFields: ["title"] };

    await expect(handlers.get(ipcChannels.writeAudio)?.(event(owner), audioPath, patch)).rejects.toThrow(/normal-audio override/i);
    expect(writeAudio).not.toHaveBeenCalled();
    await expect(handlers.get(ipcChannels.setWholeTrackOverride)?.(event(owner), audioPath, true)).resolves.toBeUndefined();
    await expect(handlers.get(ipcChannels.writeAudio)?.(event(owner), audioPath, patch)).resolves.toMatchObject({ ok: true });
    expect(writeAudio).toHaveBeenCalledTimes(1);
  });

  it("invalidates scan facts and normal-audio overrides when a new root is selected", async () => {
    const firstRoot = await temporaryDirectory("music-id3-first-");
    const secondRoot = await temporaryDirectory("music-id3-second-");
    const audioPath = path.join(firstRoot, "disc.mp3");
    await writeFile(audioPath, "fixture");
    const item: Extract<LibraryItem, { kind: "audio" }> = { kind: "audio", path: audioPath, fileName: "disc.mp3", extension: ".mp3", sizeBytes: 7, durationMs: 901_000, metadata: { common: {}, raw: {}, durationMs: 901_000 }, wholeTrackStatus: "suspected" };
    const roots = [firstRoot, secondRoot];
    const owner = sender(13);
    const handlers = register({
      showOpenDialog: async () => ({ canceled: false, filePaths: [roots.shift() as string] }),
      scanLibrary: async (_root: string, onItem: (value: LibraryItem) => void) => { onItem(item); return { items: [item], errors: [] }; },
      writeAudio: vi.fn(async () => ({ ok: true, metadata: item.metadata }))
    });
    await handlers.get(ipcChannels.selectDirectory)?.(event(owner));
    await handlers.get(ipcChannels.scanDirectory)?.(event(owner), firstRoot, "scan");
    await vi.waitFor(() => expect(owner.send).toHaveBeenCalledWith(ipcChannels.scanProgress, expect.objectContaining({ phase: "complete" })));
    await handlers.get(ipcChannels.setWholeTrackOverride)?.(event(owner), audioPath, true);

    await handlers.get(ipcChannels.selectDirectory)?.(event(owner));

    await expect(handlers.get(ipcChannels.writeAudio)?.(event(owner), audioPath, { fields: { title: "No" }, selectedFields: ["title"] })).rejects.toThrow(/outside.*selected directory|not scanned/i);
  });

  it("permits a generated CUE only inside the authorized root and binds duplicate tokens to one result", async () => {
    const root = await temporaryDirectory("music-id3-generated-");
    await mkdir(path.join(root, "album"));
    const cuePath = path.join(root, "album", "disc.cue");
    const owner = sender(21);
    const handlers = register({ showOpenDialog: async () => ({ canceled: false, filePaths: [root] }) });
    await handlers.get(ipcChannels.selectDirectory)?.(event(owner));
    const input = {
      path: cuePath,
      rawText: "",
      encoding: "utf8-bom",
      confirmationToken: "generated-once",
      document: { remarks: [], files: [{ path: "disc.mp3", type: "MP3" }], tracks: [{ number: 1, fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }], unknownLines: [] }
    };

    const first = await handlers.get(ipcChannels.saveCue)?.(event(owner), input);
    const duplicate = await handlers.get(ipcChannels.saveCue)?.(event(owner), input);

    expect(first).toEqual({ ok: true, path: cuePath });
    expect(duplicate).toEqual(first);
  });
});
