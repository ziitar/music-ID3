import { app, BrowserWindow, dialog, ipcMain, safeStorage } from "electron";
import path from "node:path";
import { registerIpcHandlers } from "./ipc/register-ipc";
import { createCookieStore } from "./services/cookie-store";

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
  registerIpcHandlers({
    ipcMain,
    showOpenDialog: (options) => dialog.showOpenDialog(options),
    cookieStore: createCookieStore({ safeStorage, userDataPath: app.getPath("userData") })
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
