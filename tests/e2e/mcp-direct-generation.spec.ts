import { _electron, expect, test, type ElectronApplication } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ConnectionStore } from "../../desktop/main/connections";
import { getProfilePaths } from "../../desktop/main/paths";
import { keepTestAppInBackground, quitApplication } from "./lifecycle";

let application: ElectronApplication;
let profile: string;

test.beforeEach(async () => {
  profile = await mkdtemp(path.join(process.platform === "win32" ? tmpdir() : "/tmp", "nai-e2e-mcp-generation-"));
  application = await _electron.launch({
    args: [path.resolve("dist/main/index.js"), "--lang=en", "--disable-gpu"],
    env: {
      ...process.env,
      NAI_STUDIO_PROFILE: profile,
      NAI_STUDIO_DRY_RUN: "1",
      NAI_STUDIO_CLIENT_HOME: path.join(profile, "client-home"),
    },
  });
  await keepTestAppInBackground(application);
});

test.afterEach(async () => {
  if (application) await quitApplication(application);
  if (profile) await rm(profile, { recursive: true, force: true });
});

test("MCP starts a bounded dry-run plan, reconnects across restart, and respects revocation", async () => {
  const page = await application.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const { recipe, connection } = await page.evaluate(async () => {
    await window.studio.call("settings.update", { language: "en" });
    const recipe = await window.studio.call("recipes.save", {
      recipe: {
        name: "MCP direct generation fixture",
        tags: [],
        rating: 0,
        source: "manual",
        notes: "",
        blocks: [{ type: "scene", tags: ["blue sky"], text: "" }],
      },
    });
    const connection = await window.studio.call("ai.connections.create", {
      name: "Synthetic bounded generator",
      permissions: { read: true, write: false, generate: true, images: true },
      maxImages: 4,
      maxAnlas: 0,
    });
    return { recipe, connection };
  });

  const paths = getProfilePaths(profile);
  const connections = new ConnectionStore(path.join(paths.secure, "connections.json"));
  const client = new Client({ name: "direct-generation-e2e", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: path.resolve("runtime/mcp", process.platform === "win32" ? "node.exe" : "node"),
    args: [path.resolve("dist/mcp/index.cjs"), "--endpoint", paths.ipcEndpoint, "--token-file", connections.tokenPath(connection.id)],
    stderr: "pipe",
  });

  try {
    await client.connect(transport);

    const prepared = await client.callTool({
      name: "generation_prepare",
      arguments: { recipe, count: 4, seed: 94107 },
    });
    expect(prepared.isError).not.toBe(true);
    const plan = prepared.structuredContent as {
      id: string;
      count: number;
      seeds: number[];
      estimatedAnlas: number | null;
      approved: boolean;
    };
    expect(plan).toMatchObject({ count: 4, seeds: [94107, 94108, 94109, 94110], estimatedAnlas: 0, approved: true });

    const beforeStart = await client.callTool({ name: "gallery_list", arguments: {} });
    expect(beforeStart.isError).not.toBe(true);
    expect((beforeStart.structuredContent as { total: number; items: unknown[] })).toMatchObject({ total: 0, items: [] });

    const started = await client.callTool({
      name: "generation_start",
      arguments: { planId: plan.id, requestId: "mcp-direct-generation-fixed-request" },
    });
    expect(started.isError).not.toBe(true);
    const job = started.structuredContent as { id: string; total: number; state: string };
    expect(job.total).toBe(4);

    await expect.poll(async () => {
      const status = await client.callTool({ name: "generation_status", arguments: { id: job.id } });
      expect(status.isError).not.toBe(true);
      return (status.structuredContent as { state: string }).state;
    }).toBe("completed");

    const repeated = await client.callTool({
      name: "generation_start",
      arguments: { planId: plan.id, requestId: "mcp-direct-generation-fixed-request" },
    });
    expect(repeated.isError).not.toBe(true);
    expect((repeated.structuredContent as { id: string; total: number })).toMatchObject({ id: job.id, total: 4 });

    const afterStart = await client.callTool({ name: "gallery_list", arguments: {} });
    expect(afterStart.isError).not.toBe(true);
    expect((afterStart.structuredContent as { total: number; items: unknown[] })).toMatchObject({ total: 4 });
    expect((afterStart.structuredContent as { items: unknown[] }).items).toHaveLength(4);

    await quitApplication(application);
    application = await _electron.launch({
      args: [path.resolve("dist/main/index.js"), "--lang=en", "--disable-gpu"],
      env: {
        ...process.env,
        NAI_STUDIO_PROFILE: profile,
        NAI_STUDIO_DRY_RUN: "1",
        NAI_STUDIO_CLIENT_HOME: path.join(profile, "client-home"),
      },
    });
    await keepTestAppInBackground(application);
    const restartedPage = await application.firstWindow();
    await restartedPage.waitForLoadState("domcontentloaded");

    const [recipesAfterRestart, galleryAfterRestart] = await Promise.all([
      client.callTool({ name: "recipes_list", arguments: {} }),
      client.callTool({ name: "gallery_list", arguments: {} }),
    ]);
    expect(recipesAfterRestart.isError).not.toBe(true);
    expect((recipesAfterRestart.structuredContent as { items: Array<{ id: number; name: string }> }).items).toContainEqual(expect.objectContaining({ id: recipe.id, name: "MCP direct generation fixture" }));
    expect(galleryAfterRestart.isError).not.toBe(true);
    expect((galleryAfterRestart.structuredContent as { total: number; items: unknown[] })).toMatchObject({ total: 4 });
    expect((galleryAfterRestart.structuredContent as { items: unknown[] }).items).toHaveLength(4);

    await restartedPage.evaluate(id => window.studio.call("ai.connections.revoke", { id }), connection.id);
    const afterRevoke = await client.callTool({
      name: "generation_prepare",
      arguments: { recipe, count: 1, seed: 94111 },
    });
    expect(afterRevoke.isError).toBe(true);
    expect(JSON.stringify(afterRevoke)).toContain("PERMISSION_DENIED");
  } finally {
    await client.close();
  }
});
