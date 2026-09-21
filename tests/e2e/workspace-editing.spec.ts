import { _electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { keepTestAppInBackground, quitApplication } from "./lifecycle";

let application: ElectronApplication | undefined;
let profile: string | undefined;

async function launchTestApp(userData: string) {
  application = await _electron.launch({
    args: [path.resolve("dist/main/index.js"), "--lang=en", "--disable-gpu"],
    env: { ...process.env, NAI_STUDIO_PROFILE: userData, NAI_STUDIO_DRY_RUN: "1", NAI_STUDIO_CLIENT_HOME: path.join(userData, "client-home") },
  });
  await keepTestAppInBackground(application);
  const page = await application.firstWindow();
  // Electron resolves beforeunload with its native confirmation handler.
  // Avoid a competing automatic CDP dialog dismissal during the restart test.
  page.on("dialog", () => {});
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(() => window.studio.call("settings.update", { language: "en" }));
  return page;
}

async function setShortcut(page: Page, key: string, shiftKey = false) {
  await page.keyboard.press(`ControlOrMeta${shiftKey ? "+Shift" : ""}+${key}`);
}

test("continues from a generation snapshot without changing its source and recovers drafts after restart", async () => {
  test.setTimeout(90_000);
  profile = await mkdtemp(path.join(tmpdir(), "nai-e2e-workspace-editing-"));
  let page = await launchTestApp(profile);

  const { source, job } = await page.evaluate(async () => {
    const character = await window.studio.call("characters.save", { character: {
      display_name: "Synthetic snapshot character", tag: "synthetic snapshot character", series: "", gender: "girl", age_flag: "adult",
      locked: false, fixed_traits: ["synthetic fixed trait"], default_x: 0.5, default_y: 0.5, notes: "Synthetic E2E fixture",
    } });
    const source = await window.studio.call("recipes.save", { recipe: {
      name: "Synthetic source recipe", tags: ["synthetic"], rating: 0, source: "manual", notes: "Synthetic source notes", blocks: [
        { type: "cast", members: [{ character_id: character.id, x: 0.5, y: 0.5, traits: [], outfit: [], expression: [], uc: [], interactions: [] }], layout_preset: "solo", auto_leak_guard: true },
        { type: "scene", tags: ["synthetic test scene"], text: "" },
        { type: "settings", width: 832, height: 1216, steps: 28, scale: 5, rescale: 0.3, sampler: "k_euler_ancestral", schedule: "karras", seed_policy: "random", quality_preset: "none", uc_preset: "heavy" },
      ],
    } });
    const plan = await window.studio.call("generation.prepare", { recipe: source, count: 1, seed: 171717 });
    await window.studio.call("generation.approve", { planId: plan.id });
    const job = await window.studio.call("generation.start", { planId: plan.id, requestId: "synthetic-continue-source" });
    return { source, job };
  });

  await expect.poll(() => page.evaluate(id => window.studio.call("generation.status", { id }).then(result => result.state), job.id)).toBe("completed");
  const sourceBefore = await page.evaluate(id => window.studio.call("recipes.get", { id }), source.id);
  const gallery = await page.evaluate(id => window.studio.call("gallery.list", { recipeId: id }), source.id);
  expect(gallery.items).toHaveLength(1);
  const generated = gallery.items[0]!;
  expect(generated.recipe.blocks.find(block => block.type === "cast")?.members[0]?.character_snapshot?.display_name).toBe("Synthetic snapshot character");

  await page.getByRole("button", { name: "Gallery", exact: true }).click();
  await expect(page.getByTitle("Enlarge").first()).toBeVisible();
  await page.getByTitle("Enlarge").first().click();
  await page.getByRole("button", { name: "Continue with the same seed", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.location.hash)).toMatch(/^#\/draft\//);
  const recipeName = page.getByLabel("Recipe name", { exact: true });
  await expect(recipeName).toHaveValue("Synthetic source recipe");

  const sameSeedDraft = await page.evaluate(() => {
    const keyPrefix = "nai-recipe-studio:draft:v1:new:";
    const raw = Array.from({ length: localStorage.length }, (_, index) => {
      const key = localStorage.key(index);
      return key?.startsWith(keyPrefix) ? localStorage.getItem(key) : null;
    }).filter((value): value is string => value !== null);
    return JSON.parse(raw.at(-1)!) as { recipe: { id?: number; source: string; blocks: Array<Record<string, unknown>> } };
  });
  const sameSettings = sameSeedDraft.recipe.blocks.find(block => block.type === "settings") as { seed_policy?: string; seed?: number } | undefined;
  expect(sameSeedDraft.recipe.id).toBeUndefined();
  expect(sameSeedDraft.recipe.source).toBe(`import:generation:${generated.id}`);
  expect(sameSettings).toMatchObject({ seed_policy: "fixed", seed: generated.seed });

  await recipeName.fill("Undo candidate");
  await page.getByRole("button", { name: "Save", exact: true }).focus();
  await setShortcut(page, "z");
  await expect(recipeName).toHaveValue("Synthetic source recipe");
  await setShortcut(page, "z", true);
  await expect(recipeName).toHaveValue("Undo candidate");
  await recipeName.fill("Saved generated copy");
  await setShortcut(page, "s");
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await expect.poll(() => page.evaluate(() => window.location.hash)).toMatch(/^#\/recipe\/\d+$/);
  const savedCopy = await page.evaluate(async () => {
    const list = await window.studio.call("recipes.list", {});
    return list.items.find(recipe => recipe.name === "Saved generated copy");
  });
  expect(savedCopy).toBeDefined();
  expect(savedCopy?.source).toBe(`import:generation:${generated.id}`);
  await expect.poll(() => page.evaluate(id => window.studio.call("recipes.get", { id }), source.id)).toEqual(sourceBefore);

  await page.getByRole("button", { name: "Gallery", exact: true }).click();
  await expect(page.getByTitle("Enlarge").first()).toBeVisible();
  await page.getByTitle("Enlarge").first().click();
  await page.getByRole("button", { name: "Continue with a new seed", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.location.hash)).toMatch(/^#\/draft\//);
  await expect(page.getByLabel("Recipe name", { exact: true })).toHaveValue("Synthetic source recipe");
  const newSeedDraft = await page.evaluate(() => {
    const keyPrefix = "nai-recipe-studio:draft:v1:new:";
    const raw = Array.from({ length: localStorage.length }, (_, index) => {
      const key = localStorage.key(index);
      return key?.startsWith(keyPrefix) ? localStorage.getItem(key) : null;
    }).filter((value): value is string => value !== null);
    return JSON.parse(raw.at(-1)!) as { recipe: { id?: number; blocks: Array<Record<string, unknown>> } };
  });
  const newSettings = newSeedDraft.recipe.blocks.find(block => block.type === "settings") as { seed_policy?: string; seed?: number } | undefined;
  expect(newSeedDraft.recipe.id).toBeUndefined();
  expect(newSettings).toMatchObject({ seed_policy: "random" });
  expect(newSettings?.seed).toBeUndefined();
  await page.getByLabel("Recipe name", { exact: true }).fill("Recover generated continuation");
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some(key => localStorage.getItem(key)?.includes("Recover generated continuation")))).toBe(true);
  await expect.poll(() => page.evaluate(id => window.studio.call("recipes.get", { id }), source.id)).toEqual(sourceBefore);

  await application!.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; });
  await quitApplication(application!);
  application = undefined;
  page = await launchTestApp(profile);
  const recoveries = page.getByRole("region", { name: "Unsaved drafts", exact: true });
  await expect(recoveries.getByText("Recover generated continuation", { exact: true })).toBeVisible();
  await recoveries.getByRole("button", { name: "Continue editing", exact: true }).click();
  await expect(page.getByLabel("Recipe name", { exact: true })).toHaveValue("Recover generated continuation");
  await expect.poll(() => page.evaluate(id => window.studio.call("recipes.get", { id }), source.id)).toEqual(sourceBefore);
});

test.afterEach(async () => {
  if (application) {
    try { await application.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; }); } catch { /* app may already be closed */ }
    await quitApplication(application);
  }
  application = undefined;
  if (profile) await rm(profile, { recursive: true, force: true });
  profile = undefined;
});
