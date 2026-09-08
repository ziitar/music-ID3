import { contextBridge, ipcRenderer } from "electron";
import type { MusicId3Api } from "../shared/ipc";

// Sandboxed preloads may only load Electron and a small set of Node built-ins.
const ipcChannels = {
  selectDirectory: "music-id3:select-directory",
  scanDirectory: "music-id3:scan-directory",
  cancelScan: "music-id3:cancel-scan",
  setWholeTrackOverride: "music-id3:set-whole-track-override",
  readAudio: "music-id3:read-audio",
  writeAudio: "music-id3:write-audio",
  readCue: "music-id3:read-cue",
  prepareCueSave: "music-id3:prepare-cue-save",
  saveCue: "music-id3:save-cue",
  previewCue: "music-id3:preview-cue",
  buildCandidateCue: "music-id3:build-candidate-cue",
  searchMetadata: "music-id3:search-metadata",
  getMetadataCandidate: "music-id3:get-metadata-candidate",
  setProviderCookie: "music-id3:set-provider-cookie",
  testProviderCookie: "music-id3:test-provider-cookie",
  getProviderCookieStatus: "music-id3:get-provider-cookie-status",
  clearOnlineCache: "music-id3:clear-online-cache",
  selectOrganizeDirectory: "music-id3:select-organize-directory",
  prepareLibraryOrganization: "music-id3:prepare-library-organization",
  executeLibraryOrganization: "music-id3:execute-library-organization",
  scanProgress: "music-id3:scan-progress"
} as const;

const musicId3: MusicId3Api = {
  selectDirectory: () => ipcRenderer.invoke(ipcChannels.selectDirectory),
  scanDirectory: (directoryPath, requestId) => ipcRenderer.invoke(ipcChannels.scanDirectory, directoryPath, requestId),
  cancelScan: (requestId) => ipcRenderer.invoke(ipcChannels.cancelScan, requestId),
  setWholeTrackOverride: (audioPath, enabled) => ipcRenderer.invoke(ipcChannels.setWholeTrackOverride, audioPath, enabled),
  readAudio: (audioPath) => ipcRenderer.invoke(ipcChannels.readAudio, audioPath),
  writeAudio: (audioPath, patch) => ipcRenderer.invoke(ipcChannels.writeAudio, audioPath, patch),
  readCue: (cuePath, sourceEncoding) => ipcRenderer.invoke(ipcChannels.readCue, cuePath, sourceEncoding),
  prepareCueSave: (input) => ipcRenderer.invoke(ipcChannels.prepareCueSave, input),
  saveCue: (input) => ipcRenderer.invoke(ipcChannels.saveCue, input),
  previewCue: (cuePath, rawText) => ipcRenderer.invoke(ipcChannels.previewCue, cuePath, rawText),
  buildCandidateCue: (input) => ipcRenderer.invoke(ipcChannels.buildCandidateCue, input),
  searchMetadata: (source, query, context) => ipcRenderer.invoke(ipcChannels.searchMetadata, source, query, context),
  getMetadataCandidate: (source, id, context) => ipcRenderer.invoke(ipcChannels.getMetadataCandidate, source, id, context),
  setProviderCookie: (source, value) => ipcRenderer.invoke(ipcChannels.setProviderCookie, source, value),
  testProviderCookie: (source) => ipcRenderer.invoke(ipcChannels.testProviderCookie, source),
  getProviderCookieStatus: (source) => ipcRenderer.invoke(ipcChannels.getProviderCookieStatus, source),
  clearOnlineCache: () => ipcRenderer.invoke(ipcChannels.clearOnlineCache),
  selectOrganizeDirectory: () => ipcRenderer.invoke(ipcChannels.selectOrganizeDirectory),
  prepareLibraryOrganization: (paths, targetRoot) => ipcRenderer.invoke(ipcChannels.prepareLibraryOrganization, paths, targetRoot),
  executeLibraryOrganization: (confirmationToken) => ipcRenderer.invoke(ipcChannels.executeLibraryOrganization, confirmationToken),
  onScanProgress: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, progress: Parameters<typeof listener>[0]) => listener(progress);
    ipcRenderer.on(ipcChannels.scanProgress, callback);
    return () => ipcRenderer.removeListener(ipcChannels.scanProgress, callback);
  }
};

contextBridge.exposeInMainWorld("musicId3", musicId3);
