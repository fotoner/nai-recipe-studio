import { APP_SCHEME } from "./paths";
import { PlatformError } from "./errors";

export const SECURE_WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  webviewTag: false,
  allowRunningInsecureContent: false,
  enableBlinkFeatures: undefined,
} as const;

export function rendererLocation(packaged: boolean, env: NodeJS.ProcessEnv = process.env) {
  const bundled = { url: `${APP_SCHEME}://app/`, origin: `${APP_SCHEME}://app`, devOrigins: [] as string[] };
  if (packaged || !env.ELECTRON_RENDERER_URL) return bundled;
  try {
    const url = new URL(env.ELECTRON_RENDERER_URL);
    if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) return bundled;
    return { url: url.href, origin: url.origin, devOrigins: [url.origin] };
  } catch { return bundled; }
}

export function createBrowserWindowOptions(preload: string, bounds: { width: number; height: number; x?: number; y?: number; maximized?: boolean }) {
  return {
    width: bounds.width,
    height: bounds.height,
    ...(bounds.x === undefined ? {} : { x: bounds.x }),
    ...(bounds.y === undefined ? {} : { y: bounds.y }),
    show: false,
    backgroundColor: "#17171b",
    webPreferences: { ...SECURE_WEB_PREFERENCES, preload },
  };
}

export function isAllowedNavigation(url: string, options: { appScheme?: string; devOrigins?: string[] } = {}) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === `${options.appScheme ?? APP_SCHEME}:` && (!parsed.hostname || parsed.hostname === "app")) return true;
    return (options.devOrigins ?? []).some(origin => url === origin || url.startsWith(origin.endsWith("/") ? origin : origin + "/"));
  } catch { return false; }
}

export function externalUrl(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new PlatformError("EXTERNAL_URL_BLOCKED", "Only web links can be opened outside the app.");
    return parsed.toString();
  } catch (error) {
    if (error instanceof PlatformError) throw error;
    throw new PlatformError("EXTERNAL_URL_BLOCKED", "The link could not be opened.", { cause: error });
  }
}

export function installWindowGuards(
  window: { webContents: {
    on: (event: string, listener: (...args: unknown[]) => void) => void;
    setWindowOpenHandler?: (handler: (details: { url: string }) => { action: "deny" | "allow"; outlivesOpener?: boolean }) => void;
  }; loadURL?: (url: string) => Promise<unknown> },
  options: { appScheme?: string; devOrigins?: string[]; openExternal?: (url: string) => Promise<unknown> | unknown; confirmUnload?: () => boolean } = {},
) {
  window.webContents.on("will-navigate", (...args: unknown[]) => {
    const event = args[0] as { preventDefault: () => void };
    const url = String(args[1] ?? "");
    if (!isAllowedNavigation(url, options)) event.preventDefault();
  });
  window.webContents.on("will-prevent-unload", (...args: unknown[]) => {
    // Preventing this Electron event allows the renderer's blocked unload.
    if (options.confirmUnload?.()) (args[0] as { preventDefault: () => void }).preventDefault();
  });
  window.webContents.on("will-attach-webview", (...args: unknown[]) => (args[0] as { preventDefault: () => void }).preventDefault());
  window.webContents.setWindowOpenHandler?.(({ url }) => {
    try {
      const safe = externalUrl(url);
      void options.openExternal?.(safe);
    } catch { /* blocked external links remain inside the app */ }
    return { action: "deny" };
  });
}
