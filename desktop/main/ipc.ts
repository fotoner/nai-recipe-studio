import { parseCommandInput, type Command } from "../../contracts/studio";
import { CommandDispatcher, type PlatformCallContext, type StudioService } from "./command-dispatch";
import { CredentialStore } from "./credentials";
import { PlatformError, serializeIpcError } from "./errors";
import { externalUrl } from "./window";

export const IPC_CHANNELS = ["studio.call", "app.openExternal", "app.getPaths", "window.setBounds"] as const;
export type IpcChannel = (typeof IPC_CHANNELS)[number];

export type IpcEvent = {
  sender?: { id?: number; getURL?: () => string };
  senderFrame?: { url?: string };
};

export type MainIpcOptions = {
  dispatcher: CommandDispatcher;
  service: StudioService;
  credentials: CredentialStore;
  paths: { userData: string; output: string };
  appOrigin?: string;
  openExternal?: (url: string) => Promise<unknown> | unknown;
  onWindowBounds?: (bounds: unknown) => Promise<unknown> | unknown;
  files?: {
    importRecipe: () => Promise<unknown>;
    exportRecipe: (input: unknown) => Promise<unknown>;
  };
};

const APP_ALLOWED_COMMANDS = new Set<Command>([
  "workspace.backup.export", "workspace.backup.inspect", "workspace.backup.restore",
  "recipes.proposals.create", "recipes.proposals.list", "recipes.proposals.apply", "recipes.proposals.undo",
  "characters.tagLookup",
  "status.read", "recipes.list", "recipes.get", "recipes.save", "recipes.duplicate", "recipes.delete", "recipes.versions",
  "characters.list", "characters.save", "characters.delete", "presets.list", "presets.save", "presets.delete", "recipe.compose", "recipe.validate",
  "generation.prepare", "generation.pending", "generation.approve", "generation.start", "generation.status", "generation.list", "generation.cancel", "gallery.list", "gallery.get", "gallery.rate", "gallery.delete", "gallery.export",
  "settings.get", "settings.update", "credentials.set", "credentials.clear", "credentials.test", "files.importRecipe", "files.exportRecipe", "files.chooseOutput", "files.openOutput", "help.open",
  "ai.connections.list", "ai.connections.create", "ai.connections.revoke", "setup.inspect", "setup.install", "setup.uninstall",
]);

export function createIpcHandlers(options: MainIpcOptions) {
  return {
    "studio.call": async (event: IpcEvent, raw: unknown) => {
      const context = rendererContext(event, options.appOrigin);
      if (!raw || typeof raw !== "object") throw new PlatformError("VALIDATION_FAILED", "Invalid IPC request.");
      const value = raw as { command?: unknown; input?: unknown };
      if (typeof value.command !== "string" || !APP_ALLOWED_COMMANDS.has(value.command as Command)) throw new PlatformError("VALIDATION_FAILED", "Unknown studio command.");
      const command = value.command as Command;
      const parsed = parseCommandInput(command, value.input);
      try {
        if (command === "files.importRecipe" && options.files) return await options.files.importRecipe();
        if (command === "files.exportRecipe" && options.files) return await options.files.exportRecipe(parsed);
        return await options.dispatcher.call(command, parsed as never, context);
      } catch (error) {
        throw serializeIpcError(error);
      }
    },
    "app.openExternal": async (event: IpcEvent, raw: unknown) => {
      rendererContext(event, options.appOrigin);
      if (!raw || typeof raw !== "object" || typeof (raw as { url?: unknown }).url !== "string") throw new PlatformError("VALIDATION_FAILED");
      const url = (raw as { url: string }).url;
      if (!options.openExternal) throw new PlatformError("EXTERNAL_URL_BLOCKED");
      const safeUrl = externalUrl(url);
      return { opened: true, value: await options.openExternal(safeUrl) };
    },
    "app.getPaths": async (event: IpcEvent) => {
      rendererContext(event, options.appOrigin);
      return { userData: options.paths.userData, output: options.paths.output };
    },
    "window.setBounds": async (event: IpcEvent, raw: unknown) => {
      rendererContext(event, options.appOrigin);
      if (!raw || typeof raw !== "object") throw new PlatformError("VALIDATION_FAILED");
      return options.onWindowBounds?.(raw) ?? { saved: false };
    },
  } satisfies Record<IpcChannel, (event: IpcEvent, payload?: unknown) => Promise<unknown>>;
}

export function registerIpcHandlers(
  ipcMain: { handle: (channel: string, listener: (event: IpcEvent, payload: unknown) => Promise<unknown>) => void; removeHandler?: (channel: string) => void },
  options: MainIpcOptions,
) {
  const handlers = createIpcHandlers(options);
  for (const channel of IPC_CHANNELS) ipcMain.handle(channel, async (event, payload) => {
    try {
      return await handlers[channel](event, payload);
    } catch (error) {
      // Electron serializes thrown Error instances with only message/name/stack.
      // Return a plain envelope from the registered handler so the preload can
      // restore the structured code and retry metadata in the renderer.
      return { __studioIpcError: true, error: serializeIpcError(error) };
    }
  });
  return () => { for (const channel of IPC_CHANNELS) ipcMain.removeHandler?.(channel); };
}

function rendererContext(event: IpcEvent, appOrigin?: string): PlatformCallContext {
  const url = event.senderFrame?.url ?? event.sender?.getURL?.() ?? "";
  if (!event.sender?.id || !url) throw new PlatformError("PERMISSION_DENIED", "The IPC sender is not a renderer frame.");
  if (appOrigin && !sameOrigin(url, appOrigin)) throw new PlatformError("PERMISSION_DENIED", "The IPC sender is not the app renderer.");
  return { source: "ui", senderId: event.sender.id };
}

function sameOrigin(actualUrl: string, expectedOrigin: string) {
  try {
    const actual = new URL(actualUrl);
    const expected = new URL(expectedOrigin);
    return actual.protocol === expected.protocol && actual.hostname === expected.hostname && actual.port === expected.port;
  } catch { return false; }
}
