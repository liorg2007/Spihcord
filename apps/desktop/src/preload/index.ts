/**
 * Sandboxed preload: exposes a minimal, typed API on `window.shpihcord`.
 * Built as CommonJS (sandboxed preloads can't be ES modules).
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC, type PttBinding, type ScreenSelectRequest, type ShpihcordApi, type StoredSession, type UpdateStatus } from "../shared/ipc";

const api: ShpihcordApi = {
  platform: process.platform,
  getVersion: () => ipcRenderer.invoke(IPC.version),
  caps: () => ipcRenderer.invoke(IPC.caps),
  openSystemSettings: (pane) => ipcRenderer.invoke(IPC.openSystemSettings, pane),
  session: {
    load: () => ipcRenderer.invoke(IPC.sessionLoad),
    save: (session: StoredSession) => ipcRenderer.invoke(IPC.sessionSave, session),
    clear: () => ipcRenderer.invoke(IPC.sessionClear),
  },
  ptt: {
    isGlobalAvailable: () => ipcRenderer.invoke(IPC.pttAvailable),
    setBinding: (binding: PttBinding | null) =>
      ipcRenderer.invoke(IPC.pttSetBinding, binding ? { code: binding.code, label: binding.label } : null),
    onState: (handler: (pressed: boolean) => void) => {
      const listener = (_e: IpcRendererEvent, pressed: unknown) => handler(pressed === true);
      ipcRenderer.on(IPC.pttState, listener);
      return () => {
        ipcRenderer.removeListener(IPC.pttState, listener);
      };
    },
    record: (timeoutMs?: number) => ipcRenderer.invoke(IPC.pttRecord, timeoutMs),
    cancelRecord: () => ipcRenderer.send(IPC.pttCancelRecord),
    accessibility: (prompt?: boolean) => ipcRenderer.invoke(IPC.pttAccessibility, prompt === true),
  },
  screen: {
    getSources: () => ipcRenderer.invoke(IPC.screenGetSources),
    audioSupport: () => ipcRenderer.invoke(IPC.screenAudioSupport),
    permission: () => ipcRenderer.invoke(IPC.screenPermission),
    select: (req: ScreenSelectRequest) =>
      ipcRenderer.invoke(IPC.screenSelect, { sourceId: req.sourceId, audio: req.audio }),
  },
  window: {
    onVisibility: (handler: (visible: boolean) => void) => {
      const listener = (_e: IpcRendererEvent, visible: unknown) => handler(visible !== false);
      ipcRenderer.on(IPC.windowVisibility, listener);
      return () => {
        ipcRenderer.removeListener(IPC.windowVisibility, listener);
      };
    },
  },
  net: {
    setHub: (serverUrl: string | null) => ipcRenderer.invoke(IPC.netSetHub, typeof serverUrl === "string" ? serverUrl : null),
  },
  updates: {
    getStatus: () => ipcRenderer.invoke(IPC.updateGetStatus),
    onStatus: (handler: (status: UpdateStatus) => void) => {
      const listener = (_e: IpcRendererEvent, status: UpdateStatus) => handler(status);
      ipcRenderer.on(IPC.updateStatus, listener);
      return () => {
        ipcRenderer.removeListener(IPC.updateStatus, listener);
      };
    },
    install: () => ipcRenderer.send(IPC.updateInstall),
  },
};

contextBridge.exposeInMainWorld("shpihcord", api);
