import { expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { MainCommandFacade } from "../desktop/main/facade";

it("imports a recipe as a new record and localizes the native dialog", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nai-import-"));
  const file = path.join(root, "recipe.json");
  const openFile = vi.fn(async () => ({ canceled: false, filePaths: [file] }));
  const facade = new MainCommandFacade({ service: { call: async () => ({ language: "ja" }) }, dialog: { openFile } } as never);
  try {
    await writeFile(file, JSON.stringify({ id: 7, name: "Synthetic existing name", tags: [], rating: 0, blocks: [], notes: "한국어・日本語", source: "manual" }));
    const imported = await facade.call("files.importRecipe", {}, { source: "ui" });
    expect(imported.recipe).toMatchObject({ name: "Synthetic existing name", notes: "한국어・日本語", source: "import:json" });
    expect(imported.recipe?.id).toBeUndefined();
    expect(openFile).toHaveBeenCalledWith(expect.objectContaining({ title: "レシピを読み込む" }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
