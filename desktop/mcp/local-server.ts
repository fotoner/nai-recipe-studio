import crypto from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRpcDispatcher, RPC_PROTOCOL_VERSION, type RpcConnection, type RpcMethod } from "./rpc";
import { PlatformError } from "../main/errors";

export type LocalMcpServerOptions = {
  endpoint: string;
  /** Static mode is retained for focused tests. Production passes connectionResolver. */
  tokenPath?: string;
  connectionId?: string;
  scopes?: string[];
  connectionResolver?: (token: string) => RpcConnection | null | Promise<RpcConnection | null>;
  methods: Record<string, RpcMethod>;
  canStartGeneration?: (params: unknown, context: { connectionId: string; scopes: string[] }) => boolean | Promise<boolean>;
  net?: { createServer: typeof createServer };
  fs?: { mkdir: typeof mkdir; chmod: typeof chmod; readFile: typeof readFile; writeFile: typeof writeFile; unlink: typeof unlink };
};

/** App-owned authenticated local pipe. No database or service is exposed to the helper. */
export class LocalMcpServer {
  private server: Server | null = null;
  private ownsUnixSocket = false;
  private readonly netImpl;
  private readonly fsImpl;
  private token = "";
  private readonly sockets = new Set<Socket>();

  constructor(private readonly options: LocalMcpServerOptions) {
    this.netImpl = options.net ?? { createServer };
    this.fsImpl = options.fs ?? { mkdir, chmod, readFile, writeFile, unlink };
  }

  async start() {
    if (this.server) return this.options.endpoint;
    if (this.options.endpoint.startsWith("/")) {
      await this.fsImpl.mkdir(path.dirname(this.options.endpoint), { recursive: true, mode: 0o700 });
    }
    if (this.options.tokenPath) {
      await this.fsImpl.mkdir(path.dirname(this.options.tokenPath), { recursive: true, mode: 0o700 });
      this.token = await this.loadOrCreateToken();
    }
    if (this.options.endpoint.startsWith("/")) {
      await this.fsImpl.mkdir(path.dirname(this.options.endpoint), { recursive: true, mode: 0o700 });
      try { await this.fsImpl.unlink(this.options.endpoint); } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT")) throw error;
      }
    }
    this.server = this.netImpl.createServer(socket => this.handleSocket(socket));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { this.server?.off("listening", onListening); reject(error); };
      const onListening = () => {
        this.server?.off("error", onError);
        if (this.options.endpoint.startsWith("/")) void this.fsImpl.chmod(this.options.endpoint, 0o600).then(resolve, reject);
        else resolve();
      };
      this.server!.once("error", onError);
      this.server!.once("listening", onListening);
      this.server!.listen(this.options.endpoint);
    });
    this.ownsUnixSocket = this.options.endpoint.startsWith("/");
    if (this.ownsUnixSocket) await this.fsImpl.chmod(this.options.endpoint, 0o600);
    return this.options.endpoint;
  }

  async stop() {
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    if (this.ownsUnixSocket) {
      try { await this.fsImpl.unlink(this.options.endpoint); } catch { /* already gone */ }
    }
    this.ownsUnixSocket = false;
  }

  private async loadOrCreateToken() {
    if (!this.options.tokenPath) throw new PlatformError("PERMISSION_DENIED", "No app connection token is configured.");
    try {
      const token = (await this.fsImpl.readFile(this.options.tokenPath, "utf8")).trim();
      if (/^[a-f0-9]{64}$/i.test(token)) return token;
    } catch { /* create below */ }
    const token = crypto.randomBytes(32).toString("hex");
    await this.fsImpl.writeFile(this.options.tokenPath, token + "\n", { encoding: "utf8", mode: 0o600 });
    await this.fsImpl.chmod(this.options.tokenPath, 0o600);
    return token;
  }

  private handleSocket(socket: Socket) {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    socket.setEncoding("utf8");
    let buffer = "";
    let queue = Promise.resolve();
    const dispatch = createRpcDispatcher({
      ...(this.options.connectionResolver
        ? { resolveConnection: this.options.connectionResolver }
        : { token: this.token, connectionId: this.options.connectionId, scopes: this.options.scopes }),
      methods: this.options.methods,
      canStartGeneration: this.options.canStartGeneration,
    });
    socket.on("data", async value => {
      buffer += String(value);
      if (Buffer.byteLength(buffer, "utf8") > 1_000_000) { socket.destroy(); return; }
      for (;;) {
        const index = buffer.indexOf("\n");
        if (index < 0) return;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        queue = queue.then(async () => {
          const response = await dispatch(line);
          if (!socket.destroyed) socket.write(JSON.stringify(response) + "\n");
        }).catch(() => { socket.destroy(); });
      }
    });
  }
}

export async function readConnectionToken(tokenPath: string) {
  const token = (await readFile(tokenPath, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/i.test(token)) throw new PlatformError("PERMISSION_DENIED", "The app connection token is invalid.");
  return token;
}

export { RPC_PROTOCOL_VERSION };
