import crypto from "node:crypto";
import net from "node:net";
import { PlatformError, asPlatformError, errorPayload } from "../main/errors";

export const RPC_PROTOCOL_VERSION = 1;
export const MAX_RPC_LINE_BYTES = 1_000_000;

export type RpcRequest = { id: string | number; method: string; params?: unknown };
export type RpcResponse = { id?: string | number; ok: boolean; result?: unknown; code?: string; error?: ReturnType<typeof errorPayload> };
export type RpcContext = { connectionId: string; scopes: string[] };
export type RpcMethod = (params: unknown, context: RpcContext) => Promise<unknown> | unknown;
export type RpcConnection = { connectionId: string; scopes: string[] };

export function readRpcRequest(line: string): RpcRequest {
  if (Buffer.byteLength(line, "utf8") > MAX_RPC_LINE_BYTES) throw new PlatformError("REQUEST_TOO_LARGE", "The MCP request is too large.");
  let value: unknown;
  try { value = JSON.parse(line); } catch (cause) { throw new PlatformError("VALIDATION_FAILED", "The MCP request is not valid JSON.", { cause }); }
  if (!value || typeof value !== "object") throw new PlatformError("VALIDATION_FAILED", "The MCP request must be an object.");
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" && typeof raw.id !== "number") throw new PlatformError("VALIDATION_FAILED", "The MCP request has no valid id.");
  if (typeof raw.method !== "string" || raw.method.length < 1 || raw.method.length > 100) throw new PlatformError("VALIDATION_FAILED", "The MCP request has no valid method.");
  return { id: raw.id, method: raw.method, params: raw.params };
}

export type RpcDispatcherOptions = {
  /** Fixed-token mode is used by isolated protocol tests. Production uses resolveConnection. */
  token?: string;
  connectionId?: string;
  scopes?: string[];
  resolveConnection?: (token: string) => RpcConnection | null | Promise<RpcConnection | null>;
  methods: Record<string, RpcMethod>;
  canStartGeneration?: (params: unknown, context: RpcContext) => boolean | Promise<boolean>;
};

/** JSON-lines protocol used only between the packaged stdio helper and the app. */
export function createRpcDispatcher(options: RpcDispatcherOptions) {
  let authenticated = false;
  let context: RpcContext | null = options.connectionId && options.scopes
    ? { connectionId: options.connectionId, scopes: [...options.scopes] }
    : null;
  return async (line: string): Promise<RpcResponse> => {
    try {
      if (Buffer.byteLength(line, "utf8") > MAX_RPC_LINE_BYTES) throw new PlatformError("REQUEST_TOO_LARGE", "The MCP request is too large.");
      let raw: unknown;
      try { raw = JSON.parse(line); } catch (cause) { throw new PlatformError("VALIDATION_FAILED", "The MCP handshake is not valid JSON.", { cause }); }
      if (raw && typeof raw === "object" && (raw as { type?: unknown }).type === "hello") {
        if ((raw as { version?: unknown }).version !== undefined && (raw as { version?: unknown }).version !== RPC_PROTOCOL_VERSION) throw new PlatformError("VALIDATION_FAILED", "The MCP connection protocol version is unsupported.");
        const candidate = (raw as { token?: unknown }).token;
        if (typeof candidate !== "string") throw new PlatformError("PERMISSION_DENIED", "The MCP connection token is invalid.");
        const resolved = options.resolveConnection
          ? await options.resolveConnection(candidate)
          : options.token !== undefined && constantTimeEqual(candidate, options.token)
            ? context
            : null;
        if (!resolved) throw new PlatformError("PERMISSION_DENIED", "The MCP connection token is invalid.");
        context = { connectionId: resolved.connectionId, scopes: [...resolved.scopes] };
        authenticated = true;
        const id = (raw as { id?: unknown }).id;
        return { ...(typeof id === "string" || typeof id === "number" ? { id } : {}), ok: true, result: { version: RPC_PROTOCOL_VERSION, connectionId: context.connectionId } };
      }
      if (!authenticated) throw new PlatformError("PERMISSION_DENIED", "Authenticate the MCP connection first.");
      if (!context) throw new PlatformError("PERMISSION_DENIED", "The MCP connection is not authorized.");
      const request = readRpcRequest(line);
      if (!options.methods[request.method]) throw new PlatformError("VALIDATION_FAILED", "The MCP method is not available.");
      if (isGenerationMethod(request.method) && !context.scopes.includes("generate")) throw new PlatformError("PERMISSION_DENIED");
      if (isWriteMethod(request.method) && !context.scopes.includes("write")) throw new PlatformError("PERMISSION_DENIED");
      if (isImageMethod(request.method) && !context.scopes.includes("images")) throw new PlatformError("PERMISSION_DENIED");
      if (request.method === "generation.start" || request.method === "generation_start") {
        if (options.canStartGeneration) {
          const allowed = await options.canStartGeneration(request.params, context);
          if (!allowed) throw new PlatformError("APPROVAL_REQUIRED", "Approve the generation plan in the app.");
        }
      }
      const result = await options.methods[request.method](request.params, context);
      return { id: request.id, ok: true, result };
    } catch (error) {
      const normalized = asPlatformError(error);
      return { ok: false, ...(typeof safeId(line) === "string" || typeof safeId(line) === "number" ? { id: safeId(line) } : {}), code: normalized.code, error: errorPayload(normalized) };
    }
  };
}

function isWriteMethod(method: string) {
  return !isGenerationMethod(method) && /(?:save|duplicate|delete|rate|cancel|update|create|revoke|start)$/i.test(method);
}

function isImageMethod(method: string) {
  return method === "gallery_export" || method === "gallery.export" || method === "resource.generation.preview";
}

function isGenerationMethod(method: string) { return method.startsWith("generation.") || method.startsWith("generation_"); }

function safeId(line: string) {
  try {
    const value = JSON.parse(line) as { id?: unknown };
    return typeof value.id === "string" || typeof value.id === "number" ? value.id : undefined;
  } catch { return undefined; }
}

function constantTimeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export type RpcSocketAddress = string | { port: number; host?: string };

export class RpcClient {
  private socket: net.Socket | null = null;
  private connecting: Promise<void> | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<string | number, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();

  constructor(private readonly address: RpcSocketAddress, private readonly token: string) {}

  async connect() {
    if (this.connecting) return this.connecting;
    if (this.socket && !this.socket.destroyed) return;
    const socket = openSocket(this.address);
    this.socket = socket;
    this.buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", value => { if (this.socket === socket) this.receive(String(value), socket); });
    socket.on("error", error => this.fail(error, socket));
    socket.on("close", () => this.fail(new PlatformError("APP_NOT_RUNNING", "NAI Recipe Studio is not running."), socket));
    const connecting = this.connectAndAuthenticate(socket);
    this.connecting = connecting;
    try {
      await connecting;
    } catch (error) {
      this.fail(error, socket);
      throw error;
    } finally {
      if (this.connecting === connecting) this.connecting = null;
    }
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    await this.connectIfNeeded();
    const id = this.nextId++;
    const message = method === "__hello__" ? params : { id, method, params };
    const body = JSON.stringify(message) + "\n";
    if (Buffer.byteLength(body) > MAX_RPC_LINE_BYTES) throw new PlatformError("REQUEST_TOO_LARGE");
    const socket = this.socket;
    if (!socket || socket.destroyed || !socket.writable) throw new PlatformError("APP_NOT_RUNNING", "NAI Recipe Studio is not running.");
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { socket.write(body); }
      catch (error) { this.fail(error, socket); }
    });
  }

  close() {
    this.fail(new PlatformError("APP_NOT_RUNNING"));
  }

  private async connectIfNeeded() {
    await this.connect();
  }

  private async connectAndAuthenticate(socket: net.Socket) {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        socket.off("connect", onConnect);
        socket.off("error", onError);
        socket.off("close", onClose);
      };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const onClose = () => { cleanup(); reject(new PlatformError("APP_NOT_RUNNING", "NAI Recipe Studio is not running.")); };
      const onConnect = () => { cleanup(); resolve(); };
      socket.once("connect", onConnect);
      socket.once("error", onError);
      socket.once("close", onClose);
    });
    if (this.socket !== socket) throw new PlatformError("APP_NOT_RUNNING", "NAI Recipe Studio is not running.");
    const id = this.nextId++;
    await new Promise<void>((resolve, reject) => {
      this.pending.set(id, { resolve: () => resolve(), reject });
      try { socket.write(JSON.stringify({ id, type: "hello", version: RPC_PROTOCOL_VERSION, token: this.token }) + "\n"); }
      catch (error) { this.fail(error, socket); }
    });
  }

  private receive(chunk: string, socket: net.Socket) {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      try {
        const response = JSON.parse(line) as RpcResponse;
        const id = response.id;
        if (id === undefined) continue;
        const pending = this.pending.get(id);
        if (!pending) continue;
        this.pending.delete(id);
        if (response.ok) pending.resolve(response.result);
        else pending.reject(new PlatformError((response.code as never) ?? "INTERNAL_ERROR", response.error?.message ?? response.code ?? "RPC error", { params: response.error?.params, retryable: response.error?.retryable }));
      } catch (error) { this.fail(error, socket); }
    }
  }

  private fail(error: unknown, sourceSocket?: net.Socket) {
    if (sourceSocket && this.socket !== sourceSocket) return;
    const socket = this.socket;
    this.socket = null;
    this.buffer = "";
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    socket?.destroy();
  }
}

function openSocket(address: RpcSocketAddress) {
  return typeof address === "string"
    ? net.createConnection(address)
    : net.createConnection(address.port, address.host);
}
