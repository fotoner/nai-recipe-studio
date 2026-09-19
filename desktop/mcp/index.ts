import { readFile } from "node:fs/promises";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { APP_NAME, APP_VERSION } from "../../contracts/studio";
import { createRecipeStudioMcpServer } from "./server";
import { RpcClient, type RpcSocketAddress } from "./rpc";

export type StdioMcpOptions = { endpoint: RpcSocketAddress; tokenPath: string; clientId?: string };

/** Entry used by the standalone bundled Node helper. Diagnostics go to stderr. */
export async function runStdioMcp(options: StdioMcpOptions) {
  const token = await readConnectionToken(options.tokenPath);
  const client = new RpcClient(options.endpoint, token);
  await client.connect();
  const server = createRecipeStudioMcpServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return { name: APP_NAME, version: APP_VERSION, clientId: options.clientId ?? "unknown", close: () => server.close() };
}

export function parseStdioArgs(argv: string[]): StdioMcpOptions {
  const value = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [key, inline] = arg.slice(2).split("=", 2);
    const next = inline ?? argv[i + 1];
    if (!inline) i++;
    if (next) value.set(key, next);
  }
  const endpoint = value.get("endpoint");
  const tokenPath = value.get("token-file");
  if (!endpoint || !tokenPath) throw new Error("Usage: recipe-studio-mcp --endpoint <socket-or-pipe> --token-file <path>");
  return { endpoint, tokenPath: path.resolve(tokenPath), ...(value.get("client-id") ? { clientId: value.get("client-id") } : {}) };
}

async function readConnectionToken(tokenPath: string) {
  const token = (await readFile(tokenPath, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error("The app connection token is invalid.");
  return token;
}

if (typeof process !== "undefined" && process.argv[1] && /(?:mcp|index)\.(?:c?js|mjs|ts)$/.test(process.argv[1])) {
  runStdioMcp(parseStdioArgs(process.argv.slice(2))).catch(error => {
    process.stderr.write(`[NAI Recipe Studio MCP] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
