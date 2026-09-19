import { _electron, expect, test, type ElectronApplication } from "@playwright/test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ConnectionStore } from "../../desktop/main/connections";
import { getProfilePaths } from "../../desktop/main/paths";
import { quitApplication } from "./lifecycle";

let application: ElectronApplication;
let profile: string;

test.beforeEach(async () => {
  profile = await mkdtemp(path.join(process.platform === "win32" ? tmpdir() : "/tmp", "nai-e2e-"));
  application = await _electron.launch({
    args: [path.resolve("dist/main/index.js"), "--lang=en", "--disable-gpu"],
    env: { ...process.env, NAI_STUDIO_PROFILE: profile, NAI_STUDIO_DRY_RUN: "1", NAI_STUDIO_CLIENT_HOME: path.join(profile, "client-home") },
  });
});

test("dry-run generation produces gallery images through the sandboxed protocol", async () => {
  const page = await application.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(() => window.studio.call("settings.update", { language: "en" }));
  const job = await page.evaluate(async () => {
    const recipe = await window.studio.call("recipes.save", { recipe: { name: "Synthetic gallery", tags: [], rating: 0, source: "manual", notes: "", blocks: [{ type: "scene", tags: ["blue sky"], text: "" }] } });
    const plan = await window.studio.call("generation.prepare", { recipe, count: 2, seed: 17 });
    await window.studio.call("generation.approve", { planId: plan.id });
    return window.studio.call("generation.start", { planId: plan.id, requestId: "e2e-generation" });
  });
  await expect.poll(() => page.evaluate(id => window.studio.call("generation.status", { id }).then(job => job.state), job.id)).toBe("completed");
  await page.getByRole("button", { name: "Gallery", exact: true }).click();
  const pictures = page.locator('[data-testid="gallery-card"] img');
  await expect(pictures).toHaveCount(2);
  await expect.poll(() => pictures.evaluateAll(nodes => nodes.every(node => (node as HTMLImageElement).naturalWidth > 0))).toBe(true);
  const emptyRecipeId = await page.evaluate(async () => (await window.studio.call("recipes.save", { recipe: { name: "Synthetic empty", tags: [], rating: 0, source: "manual", notes: "", blocks: [] } })).id);
  await page.evaluate(id => { window.location.hash = `#/gallery?recipe_id=${id}&rating_max=2`; }, emptyRecipeId);
  await expect(page.getByRole("heading", { name: "Gallery", exact: true })).toBeVisible();
  await expect(pictures).toHaveCount(0);

});

test("bundled MCP helper enforces connection permissions and revocation", async () => {
  const page = await application.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const connection = await page.evaluate(() => window.studio.call("ai.connections.create", { name: "Synthetic read-only client", permissions: { read: true, write: false, generate: false, images: false }, maxImages: 0, maxAnlas: 0 }));
  const paths = getProfilePaths(profile);
  const tokens = new ConnectionStore(path.join(paths.secure, "connections.json"));
  const client = new Client({ name: "recipe-studio-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: path.resolve("runtime/mcp", process.platform === "win32" ? "node.exe" : "node"),
    args: [path.resolve("dist/mcp/index.cjs"), "--endpoint", paths.ipcEndpoint, "--token-file", tokens.tokenPath(connection.id)],
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map(tool => tool.name)).toContain("recipes_save");
    expect(tools.tools.map(tool => tool.name)).not.toContain("generation_approve");
    const status = await client.callTool({ name: "studio_status", arguments: {} });
    expect(status.isError).not.toBe(true);
    const denied = await client.callTool({ name: "recipes_save", arguments: { recipe: { name: "Forbidden write", blocks: [], tags: [], rating: 0, source: "manual", notes: "" } } });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain("PERMISSION_DENIED");
    await page.evaluate(id => window.studio.call("ai.connections.revoke", { id }), connection.id);
    const revoked = await client.callTool({ name: "studio_status", arguments: {} });
    expect(revoked.isError).toBe(true);
  } finally { await client.close(); }
});

test.afterEach(async () => {
  if (application) await quitApplication(application);
  if (profile) await rm(profile, { recursive: true, force: true });
});

test("fresh app edits recipes offline and preserves them across language changes", async () => {
  const page = await application.firstWindow();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(() => window.studio.call("settings.update", { language: "en" }));
  await expect(page.getByText("No recipes yet", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /scenario|trend/i })).toHaveCount(0);
  const runtime = await page.evaluate(() => ({ node: typeof (window as unknown as { require?: unknown }).require, bridge: typeof window.studio.call }));
  expect(runtime).toEqual({ node: "undefined", bridge: "function" });
  expect(await application.evaluate(({ app }) => app.getPath("userData"))).toBe(profile);

  await page.getByRole("button", { name: "New recipe", exact: true }).first().click();
  await page.getByLabel("Recipe name", { exact: true }).fill("Synthetic saved recipe");
  await page.getByRole("button", { name: "Recipe editor", exact: true }).first().click();
  await page.getByRole("menuitem", { name: "Notes", exact: true }).click();
  await page.getByLabel("Notes", { exact: true }).fill("한국어・日本語・English prompt notes");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();

  const before = await page.evaluate(() => window.studio.call("recipes.list", {}));
  for (const language of ["ko", "ja", "en"] as const) {
    await page.evaluate(value => window.studio.call("settings.update", { language: value }), language);
    const after = await page.evaluate(() => window.studio.call("recipes.list", {}));
    expect(after).toEqual(before);
  }
  await page.getByRole("button", { name: "Recipes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Synthetic saved recipe", exact: true }).first()).toBeVisible();
  await page.screenshot({ path: "test-results/recipes.png", fullPage: true });
  expect(errors).toEqual([]);
});


test("AI setup installs and removes only app-owned entries in an isolated client home", async () => {
  const page = await application.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const configRoot = path.join(profile, "client-home", ".codex");
  await mkdir(configRoot, { recursive: true });
  const configPath = path.join(configRoot, "config.toml");
  const original = 'model = "synthetic-model"\n\n[mcp_servers.unrelated]\ncommand = "untouched"\n';
  await writeFile(configPath, original);
  const connection = await page.evaluate(() => window.studio.call("ai.connections.create", { name: "Synthetic setup", permissions: { read: true, write: true, generate: false, images: false }, maxImages: 0, maxAnlas: 0 }));
  const installed = await page.evaluate(connectionId => window.studio.call("setup.install", { target: "codex", connectionId }), connection.id);
  expect(installed).toMatchObject({ mcpInstalled: true, skillInstalled: true });
  const contents = await readFile(configPath, "utf8");
  expect(contents).toContain('[mcp_servers.unrelated]');
  expect(contents).toContain('[mcp_servers.nai_recipe_studio]');
  expect(contents).toContain('index.cjs');
  expect(await readFile(path.join(configRoot, "skills", "recipe-studio", "SKILL.md"), "utf8")).toContain("recipe-studio");
  await page.evaluate(() => window.studio.call("setup.uninstall", { target: "codex" }));
  const removed = await readFile(configPath, "utf8");
  expect(removed).toContain('command = "untouched"');
  expect(removed).not.toContain('[mcp_servers.nai_recipe_studio]');
  await expect(readFile(path.join(configRoot, "skills", "recipe-studio", "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("the desktop shell retains the original Tailwind geometry and shadcn theme", async () => {
  const page = await application.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(() => window.studio.call("settings.update", { language: "en" }));
  await expect(page.getByRole("button", { name: "Recipes", exact: true })).toBeVisible();
  const geometry = await page.evaluate(() => {
    const sidebar = document.querySelector("aside")!;
    const button = sidebar.querySelector("nav button")!;
    return { width: sidebar.getBoundingClientRect().width, fontSize: getComputedStyle(button).fontSize, background: getComputedStyle(document.body).backgroundColor, font: getComputedStyle(document.body).fontFamily };
  });
  expect(geometry.width).toBe(208);
  expect(geometry.fontSize).toBe("14px");
  expect(geometry.background).toBe("oklch(0.145 0 0)");
  expect(geometry.font).toContain("Geist Variable");
});

test("Korean navigation and editor retain the original product terminology", async () => {
  const page = await application.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(() => window.studio.call("settings.update", { language: "ko" }));
  const navigation = page.locator("aside nav");
  for (const name of ["갤러리", "레시피", "팔레트", "생성", "캐릭터", "설정"]) {
    await expect(navigation.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await expect(page.getByText("NSFW 블러", { exact: true })).toBeVisible();
  await expect(page.getByText("모든 화면에 적용", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "새 레시피", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "프롬프트·린트", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "표준 순서로", exact: true })).toBeVisible();
  const content = page.getByRole("group", { name: "내용", exact: true });
  await expect(content.getByRole("button", { name: "말풍선·효과음", exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "성인", exact: true }).getByRole("button", { name: "NSFW", exact: true })).toBeVisible();
  const base = page.getByRole("group", { name: "기본", exact: true });
  for (const name of ["스타일", "등급·네거티브", "설정"]) {
    await expect(base.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await expect(base.getByRole("button", { name: "캐릭터", exact: true })).toHaveCount(0);
  await page.getByLabel("레시피 이름", { exact: true }).fill("명칭 검증용 레시피");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  await page.screenshot({ path: "test-results/editor-ko.png", fullPage: true });
});

test("development loads the live Vite renderer with working IPC and Tailwind", async () => {
  await quitApplication(application);
  const { createServer } = await import("vite");
  const { default: react } = await import("@vitejs/plugin-react");
  const { default: tailwind } = await import("@tailwindcss/vite");
  const server = await createServer({
    configFile: false,
    root: path.resolve("desktop/renderer"),
    resolve: { alias: { "@": path.resolve(".") } },
    plugins: [react(), tailwind()],
    server: { host: "127.0.0.1", port: 0 },
  });
  try {
    await server.listen();
    const url = server.resolvedUrls!.local[0];
    application = await _electron.launch({
      args: [path.resolve("dist/main/index.js"), "--lang=en", "--disable-gpu"],
      env: { ...process.env, ELECTRON_RENDERER_URL: url, NAI_STUDIO_PROFILE: profile, NAI_STUDIO_DRY_RUN: "1", NAI_STUDIO_CLIENT_HOME: path.join(profile, "client-home") },
    });
    const page = await application.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    expect(page.url()).toBe(url);
    await page.evaluate(() => window.studio.call("settings.update", { language: "en" }));
    await expect(page.getByRole("heading", { name: "Recipes", exact: true })).toBeVisible();
    await expect.poll(() => page.locator("aside").first().evaluate(element => element.getBoundingClientRect().width)).toBe(208);
    expect(await page.evaluate(() => window.studio.call("recipes.list", {}))).toMatchObject({ total: 0 });
  } finally { await server.close(); }
});
