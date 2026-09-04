import { contextBridge, ipcRenderer } from "electron";
import { ipcChannels, type MusicId3Api } from "../shared/ipc";

const musicId3: MusicId3Api = {
  selectDirectory: () => ipcRenderer.invoke(ipcChannels.selectDirectory),
  scanDirectory: (directoryPath) => ipcRenderer.invoke(ipcChannels.scanDirectory, directoryPath),
  cancelScan: (scanId) => ipcRenderer.invoke(ipcChannels.cancelScan, scanId),
  readAudio: (audioPath) => ipcRenderer.invoke(ipcChannels.readAudio, audioPath),
  writeAudio: (audioPath, patch) => ipcRenderer.invoke(ipcChannels.writeAudio, audioPath, patch),
  readCue: (cuePath) => ipcRenderer.invoke(ipcChannels.readCue, cuePath),
  saveCue: (input) => ipcRenderer.invoke(ipcChannels.saveCue, input),
  previewCue: (cuePath, rawText) => ipcRenderer.invoke(ipcChannels.previewCue, cuePath, rawText),
  buildCandidateCue: (input) => ipcRenderer.invoke(ipcChannels.buildCandidateCue, input),
  searchMetadata: (source, query) => ipcRenderer.invoke(ipcChannels.searchMetadata, source, query),
  getMetadataCandidate: (source, id) => ipcRenderer.invoke(ipcChannels.getMetadataCandidate, source, id),
  setProviderCookie: (source, value) => ipcRenderer.invoke(ipcChannels.setProviderCookie, source, value),
  testProviderCookie: (source) => ipcRenderer.invoke(ipcChannels.testProviderCookie, source),
  getProviderCookieStatus: (source) => ipcRenderer.invoke(ipcChannels.getProviderCookieStatus, source),
  clearOnlineCache: () => ipcRenderer.invoke(ipcChannels.clearOnlineCache),
  onScanProgress: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, progress: Parameters<typeof listener>[0]) => listener(progress);
    ipcRenderer.on(ipcChannels.scanProgress, callback);
    return () => ipcRenderer.removeListener(ipcChannels.scanProgress, callback);
  }
};

contextBridge.exposeInMainWorld("musicId3", musicId3);
