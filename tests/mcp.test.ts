import { describe, expect, it } from "vitest";
import { createRpcDispatcher, readRpcRequest } from "../desktop/mcp/rpc";

describe("local MCP RPC boundary", () => {
  it("requires the app-issued token before dispatching a method", async () => {
    const calls: unknown[] = [];
    const dispatch = createRpcDispatcher({
      token: "secret-fixture",
      connectionId: "connection-1",
      scopes: ["read"],
      methods: {
        studio_status: async (_params, context) => { calls.push(context); return { connected: true }; },
      },
    });
    await expect(dispatch(JSON.stringify({ type: "hello", token: "wrong" }))).resolves.toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
    await expect(dispatch(JSON.stringify({ type: "hello", token: "secret-fixture" }))).resolves.toMatchObject({ ok: true });
    await expect(dispatch(JSON.stringify({ id: 1, method: "studio_status", params: {} }))).resolves.toMatchObject({ id: 1, ok: true, result: { connected: true } });
    expect(calls).toEqual([{ connectionId: "connection-1", scopes: ["read"] }]);
  });

  it("does not trust an approved flag in MCP payloads", async () => {
    const dispatch = createRpcDispatcher({ token: "t", connectionId: "c", scopes: ["generate"], methods: {
      generation_start: async () => ({ started: true }),
    }, canStartGeneration: () => false });
    await dispatch(JSON.stringify({ type: "hello", token: "t" }));
    const result = await dispatch(JSON.stringify({ id: 2, method: "generation_start", params: { planId: "p", approved: true } }));
    expect(result).toMatchObject({ id: 2, ok: false, code: "APPROVAL_REQUIRED" });
  });

  it("binds each socket to the connection selected by its app-issued token", async () => {
    const calls: unknown[] = [];
    const dispatch = createRpcDispatcher({
      resolveConnection: token => token === "token-a" ? { connectionId: "a", scopes: ["read"] } : null,
      methods: { studio_status: async (_params, context) => { calls.push(context); return { connected: true }; } },
    });
    await expect(dispatch(JSON.stringify({ id: 1, type: "hello", token: "token-a", connectionId: "forged" }))).resolves.toMatchObject({ ok: true, result: { connectionId: "a" } });
    await expect(dispatch(JSON.stringify({ id: 2, method: "studio_status", params: {} }))).resolves.toMatchObject({ ok: true });
    expect(calls).toEqual([{ connectionId: "a", scopes: ["read"] }]);
    const revoked = createRpcDispatcher({ resolveConnection: () => null, methods: {} });
    await expect(revoked(JSON.stringify({ id: 3, type: "hello", token: "token-a" }))).resolves.toMatchObject({ ok: false, code: "PERMISSION_DENIED" });
  });

  it("rejects malformed or oversized lines before service dispatch", () => {
    expect(() => readRpcRequest("not-json")).toThrowError();
    expect(readRpcRequest(JSON.stringify({ id: "bad", method: "studio_status" }))).toMatchObject({ id: "bad", method: "studio_status" });
    expect(() => readRpcRequest("x".repeat(1_000_001))).toThrowError();
  });
});
