import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { RpcClient, type RpcSocketAddress } from "../desktop/mcp/rpc";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function startServer(address: RpcSocketAddress, result: string) {
  const held = deferred();
  let connectionCount = 0;
  const server = net.createServer(socket => {
    connectionCount++;
    let authenticated = false;
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const message = JSON.parse(line) as { id: string | number; type?: string; method?: string; token?: string };
        if (message.type === "hello") {
          authenticated = message.token === "synthetic-token";
          socket.write(`${JSON.stringify({ id: message.id, ok: authenticated, result: { version: 1 } })}\n`);
        } else if (message.method === "hold") {
          held.resolve();
          socket.destroy();
        } else {
          socket.write(`${JSON.stringify({ id: message.id, ok: authenticated, result })}\n`);
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, () => { server.off("error", reject); resolve(); });
  });
  return { server, held: held.promise, get connectionCount() { return connectionCount; } };
}

async function stopServer(server: net.Server) {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

function responseWithin<T>(promise: Promise<T>, timeoutMs = 1_500) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for the local RPC response.")), timeoutMs);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

it("rejects a lost request and reconnects to a restarted local RPC listener on the next request", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "nai-mcp-reconnect-"));
  directories.push(directory);
  const address = process.platform === "win32"
    ? `\\\\.\\pipe\\nai-mcp-${randomUUID()}`
    : path.join(directory, `r-${randomUUID().slice(0, 8)}.sock`);
  let first: Awaited<ReturnType<typeof startServer>> | undefined;
  let second: Awaited<ReturnType<typeof startServer>> | undefined;
  const client = new RpcClient(address, "synthetic-token");
  try {
    first = await startServer(address, "before-restart");
    await expect(responseWithin(client.request("read"))).resolves.toBe("before-restart");

    const lostOutcome = client.request("hold").then(
      value => ({ succeeded: true, value }),
      error => ({ succeeded: false, error }),
    );
    await first.held;
    const outcome = await lostOutcome;
    expect(outcome).toMatchObject({ succeeded: false, error: { code: "APP_NOT_RUNNING" } });
    expect(first.connectionCount).toBe(1);
    await stopServer(first.server);

    second = await startServer(address, "after-restart");
    await expect(Promise.all([
      responseWithin(client.request("read")),
      responseWithin(client.request("read")),
    ])).resolves.toEqual(["after-restart", "after-restart"]);
    expect(second.connectionCount).toBe(1);
  } finally {
    client.close();
    if (second) await stopServer(second.server);
    if (first) await stopServer(first.server);
  }
});
