import path from "node:path";
import { nativeText } from "./native-text";
import { createStudioService, type StudioService } from "../../services/studio";
import type { Command, StudioEvent } from "../../contracts/studio";
import { CredentialStore, type SafeStorageLike } from "./credentials";
import { ConnectionStore } from "./connections";
import { getProfilePaths, APP_SCHEME } from "./paths";
import { SettingsStore } from "./settings";
import { registerAppProtocol, registerAppScheme } from "./protocol";
import { createBrowserWindowOptions, installWindowGuards, rendererLocation } from "./window";
import { registerIpcHandlers } from "./ipc";
import { CommandDispatcher, type StudioService as DispatchableService } from "./command-dispatch";
import { MainCommandFacade } from "./facade";
import { LocalMcpServer } from "../mcp/local-server";
import { SetupManager } from "../../services/setup";
import { stripPngMetadata } from "./png";
import { recipeJsonSchema } from "../mcp/schema";

export type ElectronAppLike = {
  isPackaged?: boolean;
  getPath(name: string): string;
  setPath?(name: string, value: string): void;
  whenReady(): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  quit(): void;
  requestSingleInstanceLock?(): boolean;
  show?(): void;
  focus?(): void;
  dock?: { show(): void };
};
export type BrowserWindowLike = {
  id?: number;
  webContents: { getURL?: () => string; send?: (channel: string, event: StudioEvent) => void; on: (event: string, listener: (...args: unknown[]) => void) => void };
  loadURL(url: string): Promise<unknown>;
  show(): void;
  isDestroyed?(): boolean;
  on(event: string, listener: (...args: unknown[]) => void): void;
  getBounds?(): { width: number; height: number; x: number; y: number };
  isMaximized?(): boolean;
};

type WindowBounds = { width: number; height: number; x?: number; y?: number; maximized?: boolean };
export type ElectronPlatform = {
  app: ElectronAppLike;
  BrowserWindow: new (options: unknown) => BrowserWindowLike;
  protocol: Parameters<typeof registerAppProtocol>[0] & Parameters<typeof registerAppScheme>[0];
  ipcMain: Parameters<typeof registerIpcHandlers>[0];
  safeStorage: SafeStorageLike;
  dialog: { showMessageBoxSync?: (options: unknown) => number; showOpenDialog(options: unknown): Promise<{ canceled: boolean; filePaths: string[] }>; showSaveDialog(options: unknown): Promise<{ canceled: boolean; filePath?: string }>; showOpenDialogSync?: (options: unknown) => string[] | undefined };
  shell: { openExternal(url: string): Promise<unknown>; openPath(path: string): Promise<string> };
};

export type DesktopApplicationOptions = {
  electron: ElectronPlatform;
  rendererRoot: string;
  preloadPath: string;
  packaged?: boolean;
  resourcesPath?: string;
  projectRoot?: string;
  createService?: (options: Parameters<typeof createStudioService>[0]) => StudioService;
};

export function chooseProfilePath(app: ElectronAppLike, env: NodeJS.ProcessEnv = process.env) {
  const packaged = app.isPackaged === true;
  if (!packaged && env.NAI_STUDIO_PROFILE) return path.resolve(env.NAI_STUDIO_PROFILE);
  return app.getPath("userData");
}

export function createDesktopApplication(options: DesktopApplicationOptions) {
  const { electron } = options;
  const app = electron.app;
  const renderer = rendererLocation(app.isPackaged === true);
  const profileOverride = chooseProfilePath(app);
  if (profileOverride !== app.getPath("userData")) app.setPath?.("userData", profileOverride);
  const paths = getProfilePaths(profileOverride, process.platform);
  const devClientHome = app.isPackaged !== true && process.env.NAI_STUDIO_CLIENT_HOME
    ? path.resolve(process.env.NAI_STUDIO_CLIENT_HOME)
    : undefined;
  const credentials = new CredentialStore(paths.credentials, electron.safeStorage);
  const connections = new ConnectionStore(path.join(paths.secure, "connections.json"));
  const settings = new SettingsStore(paths.settings);
  const backend = (options.createService ?? createStudioService)({
    dataDir: paths.data,
    outputDir: paths.output,
    getToken: () => credentials.get("novelai"),
    getConnection: id => connections.get(id),
    fetch,
    // Environment overrides are intentionally available only to local dev/E2E.
    dryRun: app.isPackaged !== true && process.env.NAI_STUDIO_DRY_RUN === "1",
  });
  const backendDispatcher = new CommandDispatcher({ service: backend as unknown as DispatchableService });
  const assets = resolveMcpAssets(options);
  const setup = new SetupManager({
    statePath: paths.setupState,
    platform: process.platform,
    skillSource: assets.skillSource,
    helperPath: assets.scriptPath,
    runtimePath: assets.runtimePath,
    scriptPath: assets.scriptPath,
    tokenPath: paths.ipcToken,
    tokenPathForConnection: connectionId => connections.tokenPath(connectionId),
    endpoint: paths.ipcEndpoint,
    homeDir: devClientHome,
    version: "0.1.0",
  });
  const facade = new MainCommandFacade({
    service: backend as unknown as DispatchableService,
    dispatcher: backendDispatcher,
    credentials,
    connections,
    setup,
    dialog: {
      openFile: options => electron.dialog.showOpenDialog(options),
      saveFile: options => electron.dialog.showSaveDialog(options),
      chooseDirectory: options => electron.dialog.showOpenDialog(options),
    },
    shell: electron.shell,
    outputPath: paths.output,
    readImage: id => backend.readImage(id),
  });
  const facadeService = {
    call: (command: Command, input: unknown, context?: Parameters<DispatchableService["call"]>[2]) => facade.call(command as never, input as never, context ?? { source: "ui" }),
    subscribe: backend.subscribe,
    close: backend.close,
  } as unknown as DispatchableService;
  const ipcDispatcher = new CommandDispatcher({ service: facadeService });
  let window: BrowserWindowLike | null = null;
  let ipcDispose: (() => void) | undefined;
  let unsubscribeBackend: (() => void) | undefined;
  const bufferedEvents: StudioEvent[] = [];
  let language = "system";
  const mcp = createMcpServer({ dispatcher: ipcDispatcher, paths, connections, readImage: id => backend.readImage(id) });

  const start = async () => {
    await app.whenReady();
    const initialSettings = await settings.get();
    language = (await backend.call("settings.get", {})).language;
    registerAppProtocol(electron.protocol, options.rendererRoot, { readImage: id => backend.readImage(id), devOrigin: renderer.devOrigins[0] });
    ipcDispose = registerIpcHandlers(electron.ipcMain, {
      dispatcher: ipcDispatcher,
      service: facadeService,
      credentials,
      paths,
      appOrigin: renderer.origin,
      openExternal: url => electron.shell.openExternal(url),
      onWindowBounds: async bounds => { await settings.update({ window: bounds as never }); return { saved: true }; },
    });
    await connections.ensureAllTokens();
    unsubscribeBackend = backend.subscribe(event => {
      if (event.type === "settings.changed") language = event.settings.language;
      if (window && !window.isDestroyed?.()) window.webContents.send?.("studio.event", event);
      else bufferedEvents.push(event);
    });
    await mcp.start();
    window = createWindow(initialSettings.window);
    flushBufferedEvents();
    app.on("second-instance", () => {
      if (window && !window.isDestroyed?.()) { window.show(); return; }
      app.show?.();
      app.focus?.();
      app.dock?.show?.();
    });
    app.on("activate", () => {
      if (!window || window.isDestroyed?.()) void settings.get().then(value => { window = createWindow(value.window); flushBufferedEvents(); });
      else window.show();
    });
    let shuttingDown = false;
    app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
    // will-quit runs only after all beforeunload confirmations accepted. A
    // cancelled quit must leave IPC, MCP and SQLite available for more editing.
    app.on("will-quit", event => {
      if (shuttingDown) return;
      (event as { preventDefault?: () => void } | undefined)?.preventDefault?.();
      shuttingDown = true;
      unsubscribeBackend?.();
      ipcDispose?.();
      void (async () => {
        try {
          await mcp.stop();
          await backend.close();
        } catch {
          // Shutdown must still release the app even if a transport or store
          // reports an error after its resources have been closed.
        } finally {
          app.quit();
        }
      })();
    });
    return { window, paths };
  };

  const createWindow = (initialBounds: WindowBounds = { width: 1280, height: 840 }) => {
    let bounds: WindowBounds = { ...initialBounds };
    const created = electron.BrowserWindow;
    const result = new created(createBrowserWindowOptions(options.preloadPath, bounds));
    installWindowGuards(result, {
      appScheme: APP_SCHEME, devOrigins: renderer.devOrigins, openExternal: url => electron.shell.openExternal(url),
      confirmUnload: () => {
        const text = nativeText(language);
        return electron.dialog.showMessageBoxSync?.({ type: "question", title: text.closeTitle, message: text.closeDescription, buttons: [text.keepOpen, text.discardAndClose], defaultId: 0, cancelId: 0, noLink: true }) === 1;
      },
    });
    result.webContents.on("did-finish-load", () => result.show());
    result.loadURL(renderer.url).catch(() => undefined);
    result.on("close", () => {
      const current = result.getBounds?.();
      if (current) bounds = { width: current.width, height: current.height, x: current.x, y: current.y };
      void settings.update({ window: { ...bounds, maximized: result.isMaximized?.() ?? false } });
    });
    return result;
  };

  const flushBufferedEvents = () => {
    if (!window || window.isDestroyed?.()) return;
    for (const event of bufferedEvents.splice(0)) window.webContents.send?.("studio.event", event);
  };

  return { start, paths, backend, credentials, settings, connections, setup, mcp, getWindow: () => window };
}

function resolveMcpAssets(options: DesktopApplicationOptions) {
  if (options.packaged ?? options.electron.app.isPackaged === true) {
    const root = options.resourcesPath ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath ?? process.cwd();
    return { runtimePath: path.join(root, "mcp", process.platform === "win32" ? "node.exe" : "node"), scriptPath: path.join(root, "mcp", "index.cjs"), skillSource: path.join(root, "skills", "recipe-studio") };
  }
  const project = options.projectRoot ?? path.resolve(__dirname, "../..");
  return { runtimePath: path.join(project, "runtime", "mcp", process.platform === "win32" ? "node.exe" : "node"), scriptPath: path.join(project, "runtime", "mcp", "index.cjs"), skillSource: path.join(project, "skills", "recipe-studio") };
}

function createMcpServer(options: { dispatcher: CommandDispatcher; paths: ReturnType<typeof getProfilePaths>; connections: ConnectionStore; readImage: (id: number) => Promise<Uint8Array> }) {
  const methods: Record<string, (params: unknown, context: { connectionId: string; scopes: string[] }) => Promise<unknown>> = {};
  const commands: Command[] = [
    "status.read", "recipes.list", "recipes.get", "recipes.save", "recipes.duplicate", "characters.list", "characters.save", "presets.list", "presets.save", "recipe.compose", "recipe.validate", "generation.prepare", "generation.start", "generation.status", "generation.cancel", "gallery.list", "gallery.get", "gallery.rate",
  ];
  for (const command of commands) {
    const key = command.replaceAll(".", "_");
    methods[command] = async (params, context) => {
      const connection = await options.connections.get(context.connectionId);
      if (!connection) throw new Error("PERMISSION_DENIED");
      const result = await options.dispatcher.call(command as never, params as never, { source: "mcp", connection });
      if (command === "status.read") return {
        ...(result as Record<string, unknown>),
        connection: { id: connection.id, name: connection.name, permissions: connection.permissions, maxImages: connection.maxImages, maxAnlas: connection.maxAnlas },
      };
      return result;
    };
    methods[key] = methods[command];
  }
  methods["resource.schema"] = async () => recipeJsonSchema();
  methods["resource.guide.blocks"] = async () => "Use recipe.compose and recipe.validate before saving.";
  methods["resource.guide.generation"] = async () => "generation.prepare returns a plan. The app must approve it before generation.start.";
  methods["resource.recipe"] = async (params, context) => {
    const id = Number((params as { id?: unknown }).id);
    const connection = await options.connections.get(context.connectionId);
    if (!connection) throw new Error("PERMISSION_DENIED");
    return options.dispatcher.call("recipes.get", { id }, { source: "mcp", connection });
  };
  methods["resource.generation.preview"] = async (params, context) => {
    const connection = await options.connections.get(context.connectionId);
    if (!connection || !connection.permissions.read || !connection.permissions.images) throw new Error("PERMISSION_DENIED");
    const id = Number((params as { id?: unknown }).id);
    if (!Number.isInteger(id) || id <= 0) throw new Error("VALIDATION_FAILED");
    const item = await options.dispatcher.call("gallery.get", { id }, { source: "mcp", connection }) as unknown as { url: string; width: number; height: number };
    const bytes = await options.readImage(id);
    if (bytes.byteLength > 10 * 1024 * 1024) throw new Error("REQUEST_TOO_LARGE");
    return { mimeType: "image/png", width: item.width, height: item.height, data: stripPngMetadata(bytes).toString("base64") };
  };
  return new LocalMcpServer({ endpoint: options.paths.ipcEndpoint, connectionResolver: token => options.connections.resolveToken(token), methods });
}

/** Electron entrypoint; the dynamic require keeps platform modules out of pure tests. */
export async function startElectronApplication() {
  const electron = require("electron") as ElectronPlatform;
  const app = electron.app;
  registerAppScheme(electron.protocol);
  const profile = chooseProfilePath(app);
  if (profile !== app.getPath("userData")) app.setPath?.("userData", profile);
  if (app.requestSingleInstanceLock && !app.requestSingleInstanceLock()) { app.quit(); return null; }
  const application = createDesktopApplication({
    electron,
    rendererRoot: path.join(__dirname, "../renderer"),
    preloadPath: path.join(__dirname, "../preload/index.js"),
    packaged: app.isPackaged,
    resourcesPath: (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
    projectRoot: path.resolve(__dirname, "../.."),
  });
  try {
    await application.start();
    return application;
  } catch (error) {
    await application.mcp.stop().catch(() => undefined);
    await application.backend.close().catch(() => undefined);
    app.quit();
    throw error;
  }
}

declare const require: (name: string) => unknown;
declare const __dirname: string;
