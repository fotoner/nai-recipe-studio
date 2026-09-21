import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CredentialStore } from "../desktop/main/credentials";
import { ConnectionStore } from "../desktop/main/connections";
import { getProfilePaths, isPathInside } from "../desktop/main/paths";
import { stripPngMetadata } from "../desktop/main/png";
import { createIpcHandlers } from "../desktop/main/ipc";
import { createStudioBridge } from "../desktop/preload";
import { rendererLocation, isAllowedNavigation, installWindowGuards } from "../desktop/main/window";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function chunk(type: string, body: Uint8Array) {
  const typeBytes = Buffer.from(type, "ascii");
  const payload = Buffer.concat([typeBytes, Buffer.from(body)]);
  const crc = Buffer.alloc(4);
  // The sanitizer preserves the original CRC. A synthetic fixture does not need a
  // valid CRC because it is never decoded as an image in this test.
  return Buffer.concat([Buffer.from([0, 0, 0, body.length]), payload, crc]);
}

describe("desktop profile and platform boundaries", () => {
  it("keeps a guarded window open unless the user accepts discarding changes", () => {
    const events = new Map<string, (...args: unknown[]) => void>();
    let accepted = false;
    let allowed = 0;
    installWindowGuards({ webContents: { on: (event, callback) => { events.set(event, callback); } } }, { confirmUnload: () => accepted });
    events.get("will-prevent-unload")?.({ preventDefault: () => { allowed++; } });
    expect(allowed).toBe(0);
    accepted = true;
    events.get("will-prevent-unload")?.({ preventDefault: () => { allowed++; } });
    expect(allowed).toBe(1);
  });
  it("uses the live renderer only for local development and keeps its origin exact", () => {
    const env = { ELECTRON_RENDERER_URL: "http://localhost:5173/" };
    expect(rendererLocation(false, env)).toEqual({ url: "http://localhost:5173/", origin: "http://localhost:5173", devOrigins: ["http://localhost:5173"] });
    expect(rendererLocation(true, env).url).toBe("recipe-studio://app/");
    for (const url of ["https://example.com/", "http://localhost.evil/", "http://user:pass@localhost:5173/"]) {
      expect(rendererLocation(false, { ELECTRON_RENDERER_URL: url }).url).toBe("recipe-studio://app/");
    }
    expect(isAllowedNavigation("http://localhost:5173/#/recipes", { devOrigins: ["http://localhost:5173"] })).toBe(true);
    expect(isAllowedNavigation("http://localhost:5174/", { devOrigins: ["http://localhost:5173"] })).toBe(false);
  });
  it("derives every writable path below the fresh app profile", () => {
    const root = path.resolve(tmpdir(), "profile", "NAI Recipe Studio");
    const paths = getProfilePaths(root);
    expect(paths.userData).toBe(root);
    expect(paths.database).toBe(path.join(root, "data", "studio.db"));
    expect(paths.output).toBe(path.join(root, "output"));
    expect(paths.credentials).toBe(path.join(root, "secure", "credentials.json"));
    expect(paths.ipcToken).toBe(path.join(root, "secure", "mcp.token"));
    expect(isPathInside(root, paths.database)).toBe(true);
    expect(isPathInside(root, path.join(root, "..", "outside"))).toBe(false);
  });

  it("never writes an API token as plaintext and refuses an unprotected fallback", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recipe-studio-credentials-"));
    const file = path.join(root, "credentials.json");
    let decryptions = 0;
    const encrypted = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value, "utf8").reverse(),
      decryptString: (value: Buffer) => { decryptions++; return Buffer.from(value).reverse().toString("utf8"); },
    };
    const store = new CredentialStore(file, encrypted);
    await store.set("novelai", "token-fixture");
    const disk = await readFile(file, "utf8");
    expect(disk).not.toContain("token-fixture");
    expect(await store.get("novelai")).toBe("token-fixture");
    expect(await store.get("novelai")).toBe("token-fixture");
    expect(decryptions).toBe(2);

    const unavailable = new CredentialStore(file, { isEncryptionAvailable: () => false } as never);
    await expect(unavailable.set("novelai", "token-fixture")).rejects.toMatchObject({ code: "CREDENTIAL_PROTECTION_UNAVAILABLE" });
    await rm(root, { recursive: true, force: true });
  });

  it("treats the Linux basic_text backend as unprotected instead of saving a weakly obfuscated token", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recipe-studio-credentials-"));
    const file = path.join(root, "credentials.json");
    const codec = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value, "utf8").reverse(),
      decryptString: (value: Buffer) => Buffer.from(value).reverse().toString("utf8"),
    };
    const weak = new CredentialStore(file, { ...codec, getSelectedStorageBackend: () => "basic_text" });
    await expect(weak.set("novelai", "token-fixture")).rejects.toMatchObject({ code: "CREDENTIAL_PROTECTION_UNAVAILABLE" });
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const keyring = new CredentialStore(file, { ...codec, getSelectedStorageBackend: () => "gnome_libsecret" });
    await keyring.set("novelai", "token-fixture");
    expect(await keyring.get("novelai")).toBe("token-fixture");
    await rm(root, { recursive: true, force: true });
  });

  it("strips textual PNG metadata while preserving image chunks", () => {
    const fixture = Buffer.concat([
      PNG_SIGNATURE,
      chunk("IHDR", Buffer.alloc(13)),
      chunk("tEXt", Buffer.from("prompt\0secret prompt", "latin1")),
      chunk("iTXt", Buffer.from("XML:com.adobe.xmp\0\0\0\0secret", "latin1")),
      chunk("IDAT", Buffer.from([1, 2, 3])),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    const cleaned = stripPngMetadata(fixture);
    expect(cleaned).toEqual(expect.any(Buffer));
    expect(cleaned.includes(Buffer.from("secret prompt"))).toBe(false);
    expect(cleaned.includes(Buffer.from("secret"))).toBe(false);
    expect(cleaned.includes(Buffer.from("IDAT"))).toBe(true);
    expect(cleaned.subarray(0, 8)).toEqual(PNG_SIGNATURE);
  });

  it("issues separate revocable MCP tokens for connection profiles", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recipe-studio-connections-"));
    const store = new ConnectionStore(path.join(root, "secure", "connections.json"));
    const connection = await store.create({ name: "fixture", permissions: { read: true, write: false, generate: false, images: false }, maxImages: 0, maxAnlas: 0 });
    const tokenPath = store.tokenPath(connection.id);
    const token = (await readFile(tokenPath, "utf8")).trim();
    expect(await store.resolveToken(token)).toEqual({ connectionId: connection.id, scopes: ["read"] });
    await store.revoke(connection.id);
    expect(await store.resolveToken(token)).toBeNull();
    await rm(root, { recursive: true, force: true });
  });

  it("accepts IPC only from the exact app origin", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recipe-studio-ipc-"));
    const paths = getProfilePaths(root);
    const credentials = new CredentialStore(paths.credentials, { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() });
    const handlers = createIpcHandlers({
      dispatcher: { call: async () => ({}) } as never,
      service: { call: async () => ({}) } as never,
      credentials,
      paths,
      appOrigin: "recipe-studio://app",
    });
    const trusted = { sender: { id: 1, getURL: () => "recipe-studio://app/" } };
    await expect(handlers["app.getPaths"](trusted)).resolves.toEqual({ userData: root, output: paths.output });
    await expect(handlers["app.getPaths"]({ sender: { id: 1, getURL: () => "recipe-studio://app.evil/" } })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await rm(root, { recursive: true, force: true });
  });

  it("restores structured IPC errors in the preload bridge", async () => {
    const bridge = createStudioBridge({
      invoke: async () => ({ __studioIpcError: true, error: { __studioError: true, code: "VERSION_CONFLICT", message: "errors.VERSION_CONFLICT", messageKey: "errors.VERSION_CONFLICT", params: { expected: 2 }, retryable: true } }),
      on() {},
      removeListener() {},
    });
    await expect(bridge.call("recipes.list", {})).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
      data: { messageKey: "errors.VERSION_CONFLICT", params: { expected: 2 }, retryable: true },
    });
  });

});
