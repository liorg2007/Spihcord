/**
 * Sandboxed preload: exposes a minimal, typed API on `window.shpihcord`.
 * Built as CommonJS (sandboxed preloads can't be ES modules).
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC, type PttBinding, type ScreenSelectRequest, type ShpihcordApi, type StoredSession } from "../shared/ipc";

const api: ShpihcordApi = {
  platform: process.platform,
  getVersion: () => ipcRenderer.invoke(IPC.version),
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
  },
  screen: {
    getSources: () => ipcRenderer.invoke(IPC.screenGetSources),
    audioSupport: () => ipcRenderer.invoke(IPC.screenAudioSupport),
    select: (req: ScreenSelectRequest) =>
      ipcRenderer.invoke(IPC.screenSelect, { sourceId: req.sourceId, audio: req.audio }),
  },
};

contextBridge.exposeInMainWorld("shpihcord", api);
