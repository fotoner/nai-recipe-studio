import { _electron, expect, test, type ElectronApplication } from "@playwright/test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
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
  profile = await mkdtemp(path.join(process.platform === "win32" ? tmpdir() : "/tmp", "nai-e2e-"));
  application = await _electron.launch({
    args: [path.resolve("dist/main/index.js"), "--lang=en", "--disable-gpu"],
    env: { ...process.env, NAI_STUDIO_PROFILE: profile, NAI_STUDIO_DRY_RUN: "1", NAI_STUDIO_CLIENT_HOME: path.join(profile, "client-home") },
  });
  await keepTestAppInBackground(application);
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
    await keepTestAppInBackground(application);
    const page = await application.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    expect(page.url()).toBe(url);
    await page.evaluate(() => window.studio.call("settings.update", { language: "en" }));
    await expect(page.getByRole("heading", { name: "Recipes", exact: true })).toBeVisible();
    await expect.poll(() => page.locator("aside").first().evaluate(element => element.getBoundingClientRect().width)).toBe(208);
    expect(await page.evaluate(() => window.studio.call("recipes.list", {}))).toMatchObject({ total: 0 });
  } finally { await server.close(); }
});

test("recipe generation stays in the editor, uses the draft, and refreshes inline results and history", async () => {
  const page = await application.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const recipeId = await page.evaluate(async () => {
    await window.studio.call("settings.update", { language: "en" });
    const character = await window.studio.call("characters.save", { character: { display_name: "Synthetic character", tag: "synthetic character", series: "", gender: "girl", age_flag: "adult", locked: false, fixed_traits: [], default_x: 0.5, default_y: 0.5, notes: "" } });
    const recipe = await window.studio.call("recipes.save", { recipe: { name: "Saved synthetic recipe", tags: [], rating: 0, source: "manual", notes: "", blocks: [
      { type: "cast", members: [{ character_id: character.id, x: 0.5, y: 0.5, traits: [], outfit: [], expression: [], uc: [], interactions: [] }], layout_preset: "solo", auto_leak_guard: true },
      { type: "scene", tags: ["blue sky"], text: "" },
      { type: "settings", width: 832, height: 1216, steps: 28, scale: 5, rescale: 0.3, sampler: "k_euler_ancestral", schedule: "karras", seed_policy: "random", quality_preset: "none", uc_preset: "heavy" },
    ] } });
    window.location.hash = `#/recipe/${recipe.id}`;
    return recipe.id;
  });
  await page.getByLabel("Recipe name", { exact: true }).fill("Unsaved generation snapshot");
  await page.getByRole("region", { name: "Recipe details" }).getByRole("button", { name: "Generate", exact: true }).click();
  await page.getByLabel("Images per run", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Generate 2 images", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const results = page.getByRole("region", { name: "Current generation results" });
  await expect(results.getByRole("button", { name: /Select result/ })).toHaveCount(2);
  await expect(page.getByRole("button", { name: /Image #\d+, seed/ })).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(`#/recipe/${recipeId}`);
  const saved = await page.evaluate(id => window.studio.call("recipes.get", { id }), recipeId);
  expect(saved.name).toBe("Saved synthetic recipe");
  const gallery = await page.evaluate(id => window.studio.call("gallery.list", { recipeId: id }), recipeId);
  expect(gallery.items).toHaveLength(2);
  expect(gallery.items.every(item => item.recipe.name === "Unsaved generation snapshot")).toBe(true);
  if (process.platform === "darwin") {
    const chrome = page.getByTestId("mac-titlebar-drag-region");
    await expect(chrome).toBeVisible();
    expect(await chrome.evaluate(element => getComputedStyle(element).getPropertyValue("app-region"))).toBe("drag");
    expect(await chrome.evaluate(element => element.getBoundingClientRect().height)).toBe(40);
  }
  await page.screenshot({ path: "test-results/recipe-generation-inline.png", fullPage: true });
  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  await expect(page.getByRole("region", { name: "Recipe details" }).getByRole("button", { name: "Save", exact: true })).toBeDisabled();
});

test("MCP change proposals keep recipes unchanged until the app selectively applies them", async () => {
  const page = await application.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const { recipe, connection } = await page.evaluate(async () => {
    const recipe = await window.studio.call("recipes.save", { recipe: { name: "Before AI proposal", tags: [], rating: 0, source: "manual", notes: "", blocks: [{ type: "scene", tags: ["indoors"], text: "" }] } });
    const connection = await window.studio.call("ai.connections.create", { name: "Synthetic proposal client", permissions: { read: true, write: true, generate: false, images: false }, maxImages: 0, maxAnlas: 0 });
    return { recipe, connection };
  });
  const paths = getProfilePaths(profile);
  const tokens = new ConnectionStore(path.join(paths.secure, "connections.json"));
  const client = new Client({ name: "proposal-integration-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: path.resolve("runtime/mcp", process.platform === "win32" ? "node.exe" : "node"),
    args: [path.resolve("dist/mcp/index.cjs"), "--endpoint", paths.ipcEndpoint, "--token-file", tokens.tokenPath(connection.id)], stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "recipe_propose_changes", arguments: { recipeId: recipe.id, expectedVersion: recipe.version, proposedRecipe: { ...recipe, name: "AI name", notes: "Separate proposed note" }, reason: "Review two independent changes" } });
    expect(result.isError).not.toBe(true);
    const proposal = result.structuredContent as { id: string; changes: Array<{ id: string; field?: string }> };
    expect(await page.evaluate(id => window.studio.call("recipes.get", { id }), recipe.id)).toEqual(recipe);
    const changeId = proposal.changes.find(change => change.field === "name")!.id;
    const applied = await page.evaluate(input => window.studio.call("recipes.proposals.apply", input), { proposalId: proposal.id, changeIds: [changeId], expectedVersion: 1 });
    expect(applied.recipe).toMatchObject({ name: "AI name", notes: "", version: 2 });
    const listed = await client.callTool({ name: "recipe_proposals_list", arguments: { recipeId: recipe.id } });
    expect(listed.isError).not.toBe(true);
    expect(JSON.stringify(listed.structuredContent)).toContain('"partial"');
    const undone = await page.evaluate(input => window.studio.call("recipes.proposals.undo", input), { proposalId: proposal.id, changeIds: [changeId], expectedVersion: 2 });
    expect(undone.recipe).toMatchObject({ name: "Before AI proposal", notes: "", version: 3 });
    const tools = await client.listTools();
    expect(tools.tools.some(tool => /proposals_apply|proposals_undo|workspace_backup/.test(tool.name))).toBe(false);
  } finally { await client.close(); }
});

test("workspace backup restores linked images and metadata without replacing existing work", async () => {
  const page = await application.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const job = await page.evaluate(async () => {
    await window.studio.call("settings.update", { language: "en" });
    const recipe = await window.studio.call("recipes.save", { recipe: { name: "Backup fixture", tags: [], rating: 0, source: "manual", notes: "original", blocks: [{ type: "scene", tags: ["blue sky"], text: "" }] } });
    const plan = await window.studio.call("generation.prepare", { recipe, count: 1, seed: 77 });
    await window.studio.call("generation.approve", { planId: plan.id });
    return window.studio.call("generation.start", { planId: plan.id, requestId: "backup-fixture" });
  });
  await expect.poll(() => page.evaluate(id => window.studio.call("generation.status", { id }).then(job => job.state), job.id)).toBe("completed");
  await page.evaluate(async () => {
    const image = (await window.studio.call("gallery.list", {})).items[0];
    await window.studio.call("gallery.rate", { id: image.id, score: 4, liked: true, note: "portable rating" });
  });
  const archivePath = path.join(profile, "workspace.naistudio");
  await application.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, archivePath);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const backup = page.getByTestId("workspace-backup");
  await backup.getByRole("button", { name: "Create backup", exact: true }).click();
  await expect(backup.getByText("Backup saved. Missing image files: 0.", { exact: true })).toBeVisible();
  const existing = await page.evaluate(async () => {
    const recipe = await window.studio.call("recipes.get", { id: 1 });
    return window.studio.call("recipes.save", { recipe: { ...recipe, notes: "existing work after backup" }, expectedVersion: recipe.version });
  });
  await backup.getByRole("button", { name: "Review backup", exact: true }).click();
  await expect(backup.getByRole("region", { name: "Backup contents", exact: true })).toBeVisible();
  await backup.getByRole("button", { name: "Restore workspace", exact: true }).click();
  await expect(backup.getByText("Backup restored. Existing data was kept.", { exact: true })).toBeVisible();
  const result = await page.evaluate(async () => ({ original: await window.studio.call("recipes.get", { id: 1 }), recipes: await window.studio.call("recipes.list", {}), gallery: await window.studio.call("gallery.list", {}) }));
  expect(result.original).toEqual(existing);
  expect(result.recipes.total).toBe(2);
  expect(result.gallery.total).toBe(2);
  const imported = result.gallery.items.find(item => item.id !== 1)!;
  expect(imported).toMatchObject({ recipe_id: 2, seed: 77, score: 4, liked: true, note: "portable rating" });
  await backup.getByRole("button", { name: "Review backup", exact: true }).click();
  await expect(backup.getByText("This backup has already been restored.", { exact: true })).toBeVisible();
  await expect(backup.getByRole("button", { name: "Restore workspace", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Gallery", exact: true }).click();
  await expect(page.locator('[data-testid="gallery-card"] img')).toHaveCount(2);
  await expect.poll(() => page.locator('[data-testid="gallery-card"] img').evaluateAll(nodes => nodes.every(node => (node as HTMLImageElement).naturalWidth > 0))).toBe(true);
});
