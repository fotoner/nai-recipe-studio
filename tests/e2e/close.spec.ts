import { _electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let application: ElectronApplication | undefined;
let profile: string | undefined;

async function launchFreshApp() {
  profile = await mkdtemp(path.join(tmpdir(), "nai-e2e-close-"));
  application = await _electron.launch({
    args: [path.resolve("dist/main/index.js"), "--lang=en", "--disable-gpu"],
    env: { ...process.env, NAI_STUDIO_PROFILE: profile, NAI_STUDIO_DRY_RUN: "1", NAI_STUDIO_CLIENT_HOME: path.join(profile, "client-home") },
  });
  return application.firstWindow();
}

async function openSavedRecipe(page: Page) {
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(async () => {
    await window.studio.call("settings.update", { language: "en" });
  });
  const recipe = await page.evaluate(() => window.studio.call("recipes.save", {
    recipe: { name: "Close fixture", tags: [], rating: 0, source: "manual", notes: "", blocks: [] },
  }));
  await page.evaluate(id => { window.location.hash = `#/recipe/${id}`; }, recipe.id);
  // The editor section label is localized and may change with the app shell;
  // the recipe name field is the stable visible editor entry point.
  await expect(page.getByLabel("Recipe name", { exact: true })).toBeVisible();
  return recipe;
}

test("keeps an unsaved recipe open when native close is declined and preserves IPC", async () => {
  const page = await launchFreshApp();
  const recipe = await openSavedRecipe(page);
  await page.getByLabel("Recipe name", { exact: true }).fill("Unsaved close draft");
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  })).toBe(true);
  expect(await application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.listenerCount("will-prevent-unload"))).toBeGreaterThan(0);

  // Electron resolves beforeunload through its native will-prevent-unload
  // handler. Keep Playwright's automatic CDP dialog dismissal out of that flow.
  page.on("dialog", () => {});
  await application!.evaluate(({ dialog }) => {
    process.env.NAI_TEST_CLOSE_PROMPTS = "0";
    dialog.showMessageBoxSync = () => {
      process.env.NAI_TEST_CLOSE_PROMPTS = String(Number(process.env.NAI_TEST_CLOSE_PROMPTS) + 1);
      return 0;
    };
  });
  await application!.evaluate(({ app }) => {
    setTimeout(() => app.quit(), 0);
  });

  await expect.poll(() => application!.evaluate(() => process.env.NAI_TEST_CLOSE_PROMPTS)).toBe("1");
  expect(page.isClosed()).toBe(false);
  await expect(page.getByLabel("Recipe name", { exact: true })).toHaveValue("Unsaved close draft");
  await expect.poll(() => page.evaluate(() => window.studio.call("status.read", {}))).toMatchObject({ dryRun: true });
  await expect.poll(() => page.evaluate(id => window.studio.call("recipes.get", { id }), recipe.id)).toMatchObject({ name: "Close fixture" });

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
});

test("clean application close drains the app and resolves", async () => {
  const page = await launchFreshApp();
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByRole("button", { name: "Recipes", exact: true })).toBeVisible();
  await application!.close();
  application = undefined;
});

test.afterEach(async () => {
  if (application) {
    try {
      await application.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; });
    } catch { /* the app may already have exited */ }
    try { await application.close(); } catch { /* preserve the test result */ }
  }
  application = undefined;
  if (profile) await rm(profile, { recursive: true, force: true });
  profile = undefined;
});
