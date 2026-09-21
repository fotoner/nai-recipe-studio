import type { Command, CommandInput, CommandOutput, StudioEvent } from "../../contracts/studio";
import { reviveIpcError } from "../main/errors";
import type { StudioBridge } from "./types";

type IpcRendererLike = {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  on(channel: string, listener: (_event: unknown, value: unknown) => void): void;
  removeListener(channel: string, listener: (_event: unknown, value: unknown) => void): void;
};
type ContextBridgeLike = { exposeInMainWorld(name: string, value: unknown): void };

export const IPC_CHANNELS = { call: "studio.call", event: "studio.event", openExternal: "app.openExternal", getPaths: "app.getPaths", setBounds: "window.setBounds" } as const;

type IpcErrorResponse = { __studioIpcError: true; error: unknown };

function isIpcErrorResponse(value: unknown): value is IpcErrorResponse {
  return Boolean(value && typeof value === "object" && (value as { __studioIpcError?: unknown }).__studioIpcError === true && "error" in value);
}

async function invoke<T>(ipcRenderer: IpcRendererLike, channel: string, payload?: unknown): Promise<T> {
  try {
    const result = await ipcRenderer.invoke(channel, payload);
    if (isIpcErrorResponse(result)) throw reviveIpcError(result.error);
    return result as T;
  } catch (error) {
    throw reviveIpcError(error);
  }
}

export function createStudioBridge(ipcRenderer: IpcRendererLike, platform: NodeJS.Platform = process.platform): StudioBridge {
  return {
    isMacOS: platform === "darwin",
    call<K extends Command>(command: K, input: CommandInput<K>) {
      return invoke<CommandOutput<K>>(ipcRenderer, IPC_CHANNELS.call, { command, input });
    },
    subscribe(listener: (event: StudioEvent) => void) {
      const wrapped = (_event: unknown, value: unknown) => listener(value as StudioEvent);
      ipcRenderer.on(IPC_CHANNELS.event, wrapped);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.event, wrapped);
    },
    openExternal(url: string) {
      return invoke<{ opened: boolean }>(ipcRenderer, IPC_CHANNELS.openExternal, { url });
    },
    getPaths() {
      return invoke<{ userData: string; output: string }>(ipcRenderer, IPC_CHANNELS.getPaths);
    },
    setWindowBounds(bounds) {
      return invoke<{ saved: boolean }>(ipcRenderer, IPC_CHANNELS.setBounds, bounds);
    },
  };
}

export function installPreloadBridge(electron: { contextBridge: ContextBridgeLike; ipcRenderer: IpcRendererLike }) {
  const bridge = createStudioBridge(electron.ipcRenderer);
  electron.contextBridge.exposeInMainWorld("studio", bridge);
  return bridge;
}

// The preload entry is bundled separately and runs with Node integration off.
declare const require: (name: string) => { contextBridge: ContextBridgeLike; ipcRenderer: IpcRendererLike };
if (typeof require === "function") {
  try { installPreloadBridge(require("electron")); } catch { /* unit tests import the pure bridge without Electron */ }
}
