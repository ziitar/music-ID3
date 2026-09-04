import { contextBridge, ipcRenderer } from "electron";
import { ipcChannels, type MusicId3Api } from "../shared/ipc";

const musicId3: MusicId3Api = {
  selectDirectory: () => ipcRenderer.invoke(ipcChannels.selectDirectory),
  scanDirectory: (directoryPath) => ipcRenderer.invoke(ipcChannels.scanDirectory, directoryPath),
  readAudio: (audioPath) => ipcRenderer.invoke(ipcChannels.readAudio, audioPath),
  writeAudio: (audioPath, patch) => ipcRenderer.invoke(ipcChannels.writeAudio, audioPath, patch),
  readCue: (cuePath) => ipcRenderer.invoke(ipcChannels.readCue, cuePath),
  saveCue: (input) => ipcRenderer.invoke(ipcChannels.saveCue, input),
  searchMetadata: (source, query) => ipcRenderer.invoke(ipcChannels.searchMetadata, source, query),
  setProviderCookie: (source, value) => ipcRenderer.invoke(ipcChannels.setProviderCookie, source, value),
  testProviderCookie: (source) => ipcRenderer.invoke(ipcChannels.testProviderCookie, source),
  onScanProgress: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, progress: Parameters<typeof listener>[0]) => listener(progress);
    ipcRenderer.on(ipcChannels.scanProgress, callback);
    return () => ipcRenderer.removeListener(ipcChannels.scanProgress, callback);
  }
};

contextBridge.exposeInMainWorld("musicId3", musicId3);
