import path from "node:path";
import { PlatformError } from "./errors";

export const PRODUCT_NAME = "NAI Recipe Studio";
export const APP_SCHEME = "recipe-studio";
export const MCP_SERVER_NAME = "nai-recipe-studio";

export type ProfilePaths = {
  userData: string;
  data: string;
  database: string;
  output: string;
  secure: string;
  credentials: string;
  settings: string;
  ipc: string;
  ipcToken: string;
  ipcEndpoint: string;
  setupState: string;
};

/**
 * The desktop build always starts from Electron's userData path. It does not
 * search the cwd, parent repositories, old browser storage, or .env files.
 */
export function getProfilePaths(userData: string, platform: NodeJS.Platform = process.platform): ProfilePaths {
  const root = path.resolve(userData);
  const endpoint = platform === "win32" ? `\\\\.\\pipe\\nai-recipe-studio-${stablePathPart(root)}` : path.join(root, "ipc", "studio.sock");
  return {
    userData: root,
    data: path.join(root, "data"),
    database: path.join(root, "data", "studio.db"),
    output: path.join(root, "output"),
    secure: path.join(root, "secure"),
    credentials: path.join(root, "secure", "credentials.json"),
    settings: path.join(root, "settings.json"),
    ipc: path.join(root, "ipc"),
    ipcToken: path.join(root, "secure", "mcp.token"),
    ipcEndpoint: endpoint,
    setupState: path.join(root, "secure", "setup-state.json"),
  };
}

function stablePathPart(value: string) {
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16);
}

export function isPathInside(root: string, candidate: string, allowRoot = false) {
  const rootPath = path.resolve(root);
  const candidatePath = path.resolve(candidate);
  if (candidatePath === rootPath) return allowRoot;
  return candidatePath.startsWith(rootPath + path.sep);
}

export function assertPathInside(root: string, candidate: string, allowRoot = false) {
  if (!isPathInside(root, candidate, allowRoot)) {
    throw new PlatformError("PATH_NOT_ALLOWED", "The requested path is outside the app data directory.", {
      params: { root: path.basename(path.resolve(root)) },
      action: "choose-a-file-inside-the-app-data-directory",
    });
  }
  return path.resolve(candidate);
}

export function resolveProfileChild(paths: ProfilePaths, child: string) {
  if (!child || path.isAbsolute(child)) throw new PlatformError("PATH_NOT_ALLOWED");
  return assertPathInside(paths.userData, path.resolve(paths.userData, child));
}
