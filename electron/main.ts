import { app, BrowserWindow, dialog, ipcMain, net, safeStorage } from "electron";
import path from "node:path";
import { registerIpcHandlers } from "./ipc/register-ipc";
import { scanDirectory } from "./services/library-scanner";
import { createCookieStore } from "./services/cookie-store";
import { createCtdbAdapter } from "./services/metadata/ctdb-adapter";
import { createElectronTransport, createHttpClient, type HttpTransport } from "./services/metadata/http-client";
import { createMusicBrainzAdapter } from "./services/metadata/musicbrainz-adapter";
import { createNeteaseAdapter } from "./services/metadata/netease-adapter";
import { createQqMusicAdapter } from "./services/metadata/qqmusic-adapter";

function e2eArgument(name: string): string | undefined {
  if (process.env.MUSIC_ID3_E2E !== "1") return undefined;
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function e2eProviderTransport(origin: string, transport: HttpTransport): HttpTransport {
  const target = new URL(origin);
  if (target.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(target.hostname)) {
    throw new Error("E2E provider origin must be a loopback HTTP URL");
  }
  return (request) => transport({
    ...request,
    url: new URL(`/${encodeURIComponent(request.url)}`, target).toString()
  });
}

function e2eScanLibrary(delayMs: number): typeof scanDirectory {
  return async (root, onItem, signal) => {
    let emissions = Promise.resolve();
    const summary = await scanDirectory(root, (item) => {
      emissions = emissions.then(async () => {
        if (signal?.aborted) return;
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (!signal?.aborted) onItem(item);
      });
    }, signal);
    await emissions;
    return summary;
  };
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js")
    }
  });

  if (app.isPackaged) {
    void window.loadFile(path.join(__dirname, "../renderer/index.html"));
  } else {
    void window.loadURL("http://127.0.0.1:5173");
  }
}

app.whenReady().then(() => {
  const fixtureRoot = e2eArgument("music-id3-e2e-root");
  const providerOrigin = e2eArgument("music-id3-e2e-provider-origin");
  const scanDelayMs = Number(e2eArgument("music-id3-e2e-scan-delay-ms") ?? 0);
  const cookieStore = createCookieStore({ safeStorage, userDataPath: app.getPath("userData") });
  const electronTransport = createElectronTransport(net);
  const http = createHttpClient({
    transport: providerOrigin ? e2eProviderTransport(providerOrigin, electronTransport) : electronTransport,
    ...(providerOrigin ? { policies: {
      musicbrainz: { minIntervalMs: 0, retries: 0 },
      ctdb: { minIntervalMs: 0, retries: 0 },
      netease: { minIntervalMs: 0, retries: 0 },
      qq: { minIntervalMs: 0, retries: 0 }
    } } : {})
  });
  registerIpcHandlers({
    ipcMain,
    showOpenDialog: fixtureRoot
      ? async () => ({ canceled: false, filePaths: [fixtureRoot] })
      : (options) => dialog.showOpenDialog(options),
    cookieStore,
    metadataAdapters: {
      musicbrainz: createMusicBrainzAdapter({
        http,
        userAgent: process.env.MUSIC_ID3_USER_AGENT
      }),
      ctdb: createCtdbAdapter({ http }),
      netease: createNeteaseAdapter({ http, cookieStore }),
      qq: createQqMusicAdapter({ http, cookieStore })
    },
    clearOnlineCache: http.clearCache,
    ...(Number.isFinite(scanDelayMs) && scanDelayMs > 0 ? { scanLibrary: e2eScanLibrary(scanDelayMs) } : {})
  });
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
