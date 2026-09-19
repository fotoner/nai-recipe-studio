import { readFile } from "node:fs/promises";
import path from "node:path";
import { APP_SCHEME } from "./paths";
import { PlatformError } from "./errors";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

export type ProtocolResponse = { status: number; headers: Record<string, string>; body: Uint8Array };

export function resolveRendererAsset(rendererRoot: string, requestUrl: string) {
  let parsed: URL;
  try { parsed = new URL(requestUrl); } catch { throw new PlatformError("PATH_NOT_ALLOWED", "Invalid app URL."); }
  if (parsed.protocol !== `${APP_SCHEME}:` || (parsed.hostname && parsed.hostname !== "app")) throw new PlatformError("PATH_NOT_ALLOWED");
  const pathname = decodeURIComponent(parsed.pathname || "/");
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = path.resolve(rendererRoot, relative);
  const root = path.resolve(rendererRoot);
  if (candidate !== root && !candidate.startsWith(root + path.sep)) throw new PlatformError("PATH_NOT_ALLOWED");
  return { candidate, contentType: MIME_TYPES[path.extname(candidate).toLowerCase()] ?? "application/octet-stream" };
}

export async function serveRendererAsset(rendererRoot: string, requestUrl: string): Promise<ProtocolResponse> {
  const { candidate, contentType } = resolveRendererAsset(rendererRoot, requestUrl);
  let body: Buffer;
  try { body = await readFile(candidate); }
  catch {
    if (path.extname(candidate) === "") {
      body = await readFile(path.join(rendererRoot, "index.html"));
      return { status: 200, headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": rendererCsp() }, body };
    }
    return { status: 404, headers: { "content-type": "text/plain; charset=utf-8" }, body: Buffer.from("Not found") };
  }
  return {
    status: 200,
    headers: { "content-type": contentType, "content-security-policy": rendererCsp() },
    body,
  };
}

export function rendererCsp() {
  return "default-src 'self' recipe-studio:; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' recipe-studio:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
}

/** Must run before app.ready so Electron treats the renderer as a secure origin. */
export function registerAppScheme(protocol: {
  registerSchemesAsPrivileged?: (schemes: Array<{ scheme: string; privileges: { standard: boolean; secure: boolean; supportFetchAPI: boolean; corsEnabled: boolean } }>) => void;
}) {
  protocol.registerSchemesAsPrivileged?.([{
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  }]);
}

export function registerAppProtocol(protocol: {
  handle?: (scheme: string, handler: (request: { url: string }) => Promise<Response>) => void;
  registerBufferProtocol?: (scheme: string, handler: (request: { url: string }, callback: (result: { mimeType: string; data: Buffer }) => void) => void) => void;
}, rendererRoot: string, options: { readImage?: (id: number) => Promise<Uint8Array>; devOrigin?: string } = {}) {
  if (typeof protocol.handle === "function") {
    protocol.handle(APP_SCHEME, async request => {
      try {
        const url = new URL(request.url);
        const imageId = /^\/images\/([1-9]\d*)$/.exec(url.pathname);
        if (url.hostname === "app" && imageId && options.readImage) {
          const id = Number(imageId[1]);
          if (!Number.isSafeInteger(id)) throw new PlatformError("PATH_NOT_ALLOWED");
          return new Response(await options.readImage(id) as BodyInit, {
            headers: { "content-type": "image/png", "cache-control": "no-store", "content-security-policy": rendererCsp(), "x-content-type-options": "nosniff", ...(options.devOrigin ? { "access-control-allow-origin": options.devOrigin } : {}) },
          });
        }
        const response = await serveRendererAsset(rendererRoot, request.url);
        return new Response(response.body as BodyInit, { status: response.status, headers: response.headers });
      } catch (error) {
        return new Response(error instanceof PlatformError ? error.message : "Not found", { status: 403 });
      }
    });
    return;
  }
  if (typeof protocol.registerBufferProtocol === "function") {
    protocol.registerBufferProtocol(APP_SCHEME, async (request, callback) => {
      try {
        const url = new URL(request.url);
        const imageId = /^\/images\/([1-9]\d*)$/.exec(url.pathname);
        if (url.hostname === "app" && imageId && options.readImage) {
          const id = Number(imageId[1]);
          if (!Number.isSafeInteger(id)) throw new PlatformError("PATH_NOT_ALLOWED");
          callback({ mimeType: "image/png", data: Buffer.from(await options.readImage(id)) });
          return;
        }
        const response = await serveRendererAsset(rendererRoot, request.url);
        callback({ mimeType: response.headers["content-type"], data: Buffer.from(response.body) });
      } catch { callback({ mimeType: "text/plain", data: Buffer.from("Forbidden") }); }
    });
    return;
  }
  throw new PlatformError("INTERNAL_ERROR", "Electron does not support the app protocol API.");
}
