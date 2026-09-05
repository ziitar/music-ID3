import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerIpcHandlers } from "../../electron/ipc/register-ipc";
import { createCueService } from "../../electron/services/cue-service";
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

async function createLinkOrSkip(
  skip: (condition?: boolean, message?: string) => void,
  target: string,
  linkPath: string,
  type: "file" | "junction"
): Promise<boolean> {
  try {
    await symlink(target, linkPath, type);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (["EACCES", "EPERM", "ENOSYS", "ENOTSUP"].includes(code ?? "")) {
      skip(true, `Host cannot create a ${type} link (${code})`);
      return false;
    }
    throw error;
  }
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

  it("rejects canonical junction escapes and paths with the wrong capability extension", async ({ skip }) => {
    const root = await temporaryDirectory("music-id3-root-");
    const outside = await temporaryDirectory("music-id3-outside-");
    const outsideCue = path.join(outside, "outside.cue");
    await writeFile(outsideCue, 'FILE "disc.flac" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00');
    const junction = path.join(root, "escape");
    if (!(await createLinkOrSkip(skip, outside, junction, "junction"))) return;
    const notes = path.join(root, "notes.txt");
    await writeFile(notes, "not audio");
    const owner = sender(7);
    const handlers = register({ showOpenDialog: async () => ({ canceled: false, filePaths: [root] }) });
    await handlers.get(ipcChannels.selectDirectory)?.(event(owner));

    await expect(handlers.get(ipcChannels.readCue)?.(event(owner), path.join(junction, "outside.cue"))).rejects.toThrow(/outside.*selected directory/i);
    await expect(handlers.get(ipcChannels.readAudio)?.(event(owner), notes)).rejects.toThrow(/supported audio/i);
    await expect(handlers.get(ipcChannels.saveCue)?.(event(owner), { path: path.join(root, "not-a-cue.txt"), rawText: "", encoding: "utf8", confirmationToken: "wrong-extension", document: {} })).rejects.toThrow(/\.cue/i);
    await expect(handlers.get(ipcChannels.saveCue)?.(event(owner), { path: path.join(junction, "missing.cue"), rawText: "", encoding: "utf8", confirmationToken: "escaped-new-cue", document: {} })).rejects.toThrow(/outside.*selected directory/i);
  });

  it("rejects CUE and audio aliases whose canonical targets have disallowed extensions", async ({ skip }) => {
    const root = await temporaryDirectory("music-id3-masquerade-");
    const notes = path.join(root, "notes.txt");
    const cueAlias = path.join(root, "alias.cue");
    const audioAlias = path.join(root, "alias.mp3");
    await writeFile(notes, "not a CUE or audio file");
    if (!(await createLinkOrSkip(skip, notes, cueAlias, "file"))) return;
    if (!(await createLinkOrSkip(skip, notes, audioAlias, "file"))) return;
    const readCueFile = vi.fn(async () => ({ path: notes }));
    const readAudio = vi.fn(async () => ({ common: {}, raw: {}, durationMs: 0 }));
    const owner = sender(8);
    const handlers = register({
      showOpenDialog: async () => ({ canceled: false, filePaths: [root] }),
      readCueFile,
      readAudio
    });
    await handlers.get(ipcChannels.selectDirectory)?.(event(owner));

    await expect(handlers.get(ipcChannels.readCue)?.(event(owner), cueAlias)).rejects.toThrow(/CUE.*extension/i);
    await expect(handlers.get(ipcChannels.readAudio)?.(event(owner), audioAlias)).rejects.toThrow(/supported audio extension/i);
    expect(readCueFile).not.toHaveBeenCalled();
    expect(readAudio).not.toHaveBeenCalled();
  });

  it("rejects a generated CUE save when its canonical parent changes after IPC authorization", async ({ skip }) => {
    const root = await temporaryDirectory("music-id3-parent-swap-root-");
    const outside = await temporaryDirectory("music-id3-parent-swap-outside-");
    const probe = path.join(root, "junction-probe");
    if (!(await createLinkOrSkip(skip, outside, probe, "junction"))) return;
    await rm(probe, { recursive: true, force: true });
    const targetDirectory = path.join(root, "album");
    const parkedDirectory = path.join(root, "album-original");
    const cuePath = path.join(targetDirectory, "new.cue");
    await mkdir(targetDirectory);
    const service = createCueService();
    const saveAfterParentSwap: typeof service.saveCue = async (input, scope) => {
      await rename(targetDirectory, parkedDirectory);
      await symlink(outside, targetDirectory, "junction");
      return service.saveCue(input, scope);
    };
    const owner = sender(14);
    const handlers = register({
      showOpenDialog: async () => ({ canceled: false, filePaths: [root] }),
      prepareCueSaveFile: service.prepareCueSave,
      saveCueFile: saveAfterParentSwap
    });
    await handlers.get(ipcChannels.selectDirectory)?.(event(owner));
    const draft = {
      path: cuePath,
      rawText: "",
      encoding: "utf8",
      document: {
        remarks: [],
        files: [{ path: "disc.bin", type: "BINARY" }],
        tracks: [{ number: 1, type: "MODE1/2352", fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }],
        unknownLines: []
      }
    };
    const confirmationToken = await handlers.get(ipcChannels.prepareCueSave)?.(event(owner), draft);

    const result = await handlers.get(ipcChannels.saveCue)?.(event(owner), { ...draft, confirmationToken });

    expect(result).toEqual({ ok: false, error: expect.stringMatching(/canonical|changed/i) });
    await expect(readFile(path.join(outside, "new.cue"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a generated CUE save when its parent is replaced at the same canonical path", async () => {
    const root = await temporaryDirectory("music-id3-parent-identity-root-");
    const targetDirectory = path.join(root, "album");
    const parkedDirectory = path.join(root, "album-original");
    const cuePath = path.join(targetDirectory, "new.cue");
    await mkdir(targetDirectory);
    const service = createCueService();
    const saveAfterParentReplacement: typeof service.saveCue = async (input, scope) => {
      await rename(targetDirectory, parkedDirectory);
      await mkdir(targetDirectory);
      return service.saveCue(input, scope);
    };
    const owner = sender(18);
    const handlers = register({
      showOpenDialog: async () => ({ canceled: false, filePaths: [root] }),
      prepareCueSaveFile: service.prepareCueSave,
      saveCueFile: saveAfterParentReplacement
    });
    await handlers.get(ipcChannels.selectDirectory)?.(event(owner));
    const draft = {
      path: cuePath,
      rawText: "",
      encoding: "utf8",
      document: {
        remarks: [],
        files: [{ path: "disc.bin", type: "BINARY" }],
        tracks: [{ number: 1, type: "MODE1/2352", fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }],
        unknownLines: []
      }
    };
    const confirmationToken = await handlers.get(ipcChannels.prepareCueSave)?.(event(owner), draft);

    const result = await handlers.get(ipcChannels.saveCue)?.(event(owner), { ...draft, confirmationToken });

    expect(result).toEqual({ ok: false, error: expect.stringMatching(/changed since confirmation/i) });
    await expect(readFile(cuePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("saves valid mixed-mode CUE references without granting them direct audio capability", async () => {
    const root = await temporaryDirectory("music-id3-mixed-mode-");
    const binaryPath = path.join(root, "disc.bin");
    await writeFile(binaryPath, "binary fixture");
    const cuePath = path.join(root, "mixed.cue");
    const owner = sender(9);
    const handlers = register({ showOpenDialog: async () => ({ canceled: false, filePaths: [root] }) });
    await handlers.get(ipcChannels.selectDirectory)?.(event(owner));
    const input = {
      path: cuePath,
      rawText: "",
      encoding: "utf8",
      document: {
        remarks: [],
        files: [
          { path: "disc.bin", type: "BINARY" },
          { path: "missing.aiff", type: "AIFF" },
          { path: "missing.raw", type: "MOTOROLA" }
        ],
        tracks: [
          { number: 1, type: "MODE1/2352", fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] },
          { number: 2, type: "AUDIO", fileIndex: 1, indexes: [{ number: 1, time: "00:00:00" }] },
          { number: 3, type: "AUDIO", fileIndex: 2, indexes: [{ number: 1, time: "00:00:00" }] }
        ],
        unknownLines: []
      }
    };

    const confirmationToken = await handlers.get(ipcChannels.prepareCueSave)?.(event(owner), input);
    await expect(handlers.get(ipcChannels.saveCue)?.(event(owner), { ...input, confirmationToken })).resolves.toEqual({ ok: true, path: cuePath });
    expect(await readFile(cuePath, "utf8")).toContain('FILE "disc.bin" BINARY');
    expect(await readFile(cuePath, "utf8")).toContain('FILE "missing.raw" MOTOROLA');
    await expect(handlers.get(ipcChannels.readAudio)?.(event(owner), binaryPath)).rejects.toThrow(/supported audio extension/i);
  });

  it("rejects an MP3 CUE FILE type that names a non-MP3 path", async () => {
    const root = await temporaryDirectory("music-id3-mp3-reference-");
    const cuePath = path.join(root, "invalid-mp3.cue");
    const owner = sender(11);
    const handlers = register({ showOpenDialog: async () => ({ canceled: false, filePaths: [root] }) });
    await handlers.get(ipcChannels.selectDirectory)?.(event(owner));

    await expect(handlers.get(ipcChannels.prepareCueSave)?.(event(owner), {
      path: cuePath,
      rawText: "",
      encoding: "utf8",
      document: {
        remarks: [],
        files: [{ path: "disc.bin", type: "MP3" }],
        tracks: [{ number: 1, type: "AUDIO", fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }],
        unknownLines: []
      }
    })).rejects.toThrow(/MP3.*\.mp3/i);
    await expect(readFile(cuePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an MP3 CUE FILE alias whose canonical target is not MP3", async ({ skip }) => {
    const root = await temporaryDirectory("music-id3-mp3-alias-");
    const binaryPath = path.join(root, "disc.bin");
    const mp3Alias = path.join(root, "disc.mp3");
    await writeFile(binaryPath, "not mp3 data");
    if (!(await createLinkOrSkip(skip, binaryPath, mp3Alias, "file"))) return;
    const cuePath = path.join(root, "invalid-mp3-alias.cue");
    const owner = sender(19);
    const handlers = register({ showOpenDialog: async () => ({ canceled: false, filePaths: [root] }) });
    await handlers.get(ipcChannels.selectDirectory)?.(event(owner));

    await expect(handlers.get(ipcChannels.prepareCueSave)?.(event(owner), {
      path: cuePath,
      rawText: "",
      encoding: "utf8",
      document: {
        remarks: [],
        files: [{ path: "disc.mp3", type: "MP3" }],
        tracks: [{ number: 1, type: "AUDIO", fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }],
        unknownLines: []
      }
    })).rejects.toThrow(/MP3.*canonical.*\.mp3/i);
    await expect(readFile(cuePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("validates references from the exact serialized CUE instead of injectable structured fields", async () => {
    const root = await temporaryDirectory("music-id3-serialized-reference-root-");
    const outside = await temporaryDirectory("music-id3-serialized-reference-outside-");
    const cuePath = path.join(root, "injected.cue");
    const outsidePath = path.join(outside, "disc.bin");
    const owner = sender(15);
    const handlers = register({ showOpenDialog: async () => ({ canceled: false, filePaths: [root] }) });
    await handlers.get(ipcChannels.selectDirectory)?.(event(owner));

    await expect(handlers.get(ipcChannels.prepareCueSave)?.(event(owner), {
      path: cuePath,
      rawText: "",
      encoding: "utf8",
      document: {
        remarks: [],
        files: [{ path: "disc.bin", type: `BINARY\nFILE "${outsidePath}" BINARY` }],
        tracks: [{ number: 1, type: "MODE1/2352", fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }],
        unknownLines: []
      }
    })).rejects.toThrow(/outside.*selected directory/i);
    await expect(readFile(cuePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not validate a UNC CUE reference as a collapsed local path", async () => {
    const root = await temporaryDirectory("music-id3-unc-reference-");
    const localRootSuffix = root.slice(path.parse(root).root.length).replace(/[\\/]+/g, "\\");
    const uncReference = `\\\\${localRootSuffix}\\disc.bin`;
    const cuePath = path.join(root, "unc.cue");
    const owner = sender(17);
    const handlers = register({ showOpenDialog: async () => ({ canceled: false, filePaths: [root] }) });
    await handlers.get(ipcChannels.selectDirectory)?.(event(owner));

    await expect(handlers.get(ipcChannels.prepareCueSave)?.(event(owner), {
      path: cuePath,
      rawText: "",
      encoding: "utf8",
      document: {
        remarks: [],
        files: [{ path: uncReference, type: "BINARY" }],
        tracks: [{ number: 1, type: "MODE1/2352", fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }],
        unknownLines: []
      }
    })).rejects.toThrow(/UNC|outside.*selected directory/i);
  });

  it("rejects an existing BINARY CUE reference that escapes through a junction", async ({ skip }) => {
    const root = await temporaryDirectory("music-id3-reference-root-");
    const outside = await temporaryDirectory("music-id3-reference-outside-");
    await writeFile(path.join(outside, "disc.bin"), "outside binary");
    const junction = path.join(root, "escape");
    if (!(await createLinkOrSkip(skip, outside, junction, "junction"))) return;
    const cuePath = path.join(root, "escape.cue");
    const owner = sender(10);
    const handlers = register({ showOpenDialog: async () => ({ canceled: false, filePaths: [root] }) });
    await handlers.get(ipcChannels.selectDirectory)?.(event(owner));

    await expect(handlers.get(ipcChannels.saveCue)?.(event(owner), {
      path: cuePath,
      rawText: "",
      encoding: "utf8",
      confirmationToken: "escaped-binary",
      document: {
        remarks: [],
        files: [{ path: path.join("escape", "disc.bin"), type: "BINARY" }],
        tracks: [{ number: 1, type: "MODE1/2352", fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }],
        unknownLines: []
      }
    })).rejects.toThrow(/outside.*selected directory/i);
  });

  it("rejects a dangling CUE reference link instead of treating it as a missing in-root file", async ({ skip }) => {
    const root = await temporaryDirectory("music-id3-dangling-reference-root-");
    const outside = await temporaryDirectory("music-id3-dangling-reference-outside-");
    const linkPath = path.join(root, "future.bin");
    if (!(await createLinkOrSkip(skip, path.join(outside, "future.bin"), linkPath, "file"))) return;
    const cuePath = path.join(root, "dangling.cue");
    const owner = sender(16);
    const handlers = register({ showOpenDialog: async () => ({ canceled: false, filePaths: [root] }) });
    await handlers.get(ipcChannels.selectDirectory)?.(event(owner));

    await expect(handlers.get(ipcChannels.prepareCueSave)?.(event(owner), {
      path: cuePath,
      rawText: "",
      encoding: "utf8",
      document: {
        remarks: [],
        files: [{ path: "future.bin", type: "BINARY" }],
        tracks: [{ number: 1, type: "MODE1/2352", fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }],
        unknownLines: []
      }
    })).rejects.toThrow(/unresolved|symbolic|outside/i);
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
      document: { remarks: [], files: [{ path: "disc.mp3", type: "MP3" }], tracks: [{ number: 1, fileIndex: 0, indexes: [{ number: 1, time: "00:00:00" }] }], unknownLines: [] }
    };

    const confirmationToken = await handlers.get(ipcChannels.prepareCueSave)?.(event(owner), input);
    const first = await handlers.get(ipcChannels.saveCue)?.(event(owner), { ...input, confirmationToken });
    const duplicate = await handlers.get(ipcChannels.saveCue)?.(event(owner), { ...input, confirmationToken });

    expect(first).toEqual({ ok: true, path: cuePath });
    expect(duplicate).toEqual(first);
  });
});
