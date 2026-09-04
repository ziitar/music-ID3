import { app, BrowserWindow, dialog, ipcMain, net, safeStorage } from "electron";
import path from "node:path";
import { registerIpcHandlers } from "./ipc/register-ipc";
import { createCookieStore } from "./services/cookie-store";
import { createCtdbAdapter } from "./services/metadata/ctdb-adapter";
import { createElectronTransport, createHttpClient } from "./services/metadata/http-client";
import { createMusicBrainzAdapter } from "./services/metadata/musicbrainz-adapter";
import { createNeteaseAdapter } from "./services/metadata/netease-adapter";
import { createQqMusicAdapter } from "./services/metadata/qqmusic-adapter";

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
  const cookieStore = createCookieStore({ safeStorage, userDataPath: app.getPath("userData") });
  const http = createHttpClient({ transport: createElectronTransport(net) });
  registerIpcHandlers({
    ipcMain,
    showOpenDialog: (options) => dialog.showOpenDialog(options),
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
    clearOnlineCache: http.clearCache
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
