import * as React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCommandInput, type Command, type StudioClient } from "../contracts/studio";
import { changeLanguage } from "../i18n";
import { RendererApp } from "../features/app/AppShell";
import { newRecipe, type Recipe } from "../features/shared/types";

function storedRecipe(): Recipe {
  return { ...newRecipe("Morning recipe"), id: 7, version: 1, created_at: "2026-09-20T09:00:00.000Z", updated_at: "2026-09-20T09:00:00.000Z" };
}

function fakeClient() {
  const initial = storedRecipe();
  const calls: Array<[string, unknown]> = [];
  const call = vi.fn(async (command: string, input: unknown) => {
    calls.push([command, input]);
    parseCommandInput(command as Command, input);
    if (command === "settings.get") return { language: "en", blurSensitive: false, outputDirectory: "/tmp/output" };
    if (command === "status.read") return { appVersion: "0.1.0", schemaVersion: 1, connected: false, account: null, dryRun: true, locale: "en" };
    if (command === "recipes.get") return initial;
    if (command === "recipes.list") return { items: [initial], total: 1 };
    if (command === "recipes.save") return { ...initial, ...(input as { recipe: Recipe }).recipe, version: 2 };
    if (command === "characters.list" || command === "presets.list") return { items: [], total: 0 };
    if (command === "gallery.list") return { items: [], total: 0 };
    if (command === "recipes.versions") return [];
    if (command === "recipe.compose") return { base_prompt: "", negative: "", characters: [], settings: { type: "settings", width: 832, height: 1216, steps: 28, scale: 5, rescale: 0.3, sampler: "k_euler_ancestral", schedule: "karras", seed_policy: "random", quality_preset: "none", uc_preset: "heavy" }, rating: 0 };
    if (command === "recipe.validate") return { findings: [], recipe: (input as { recipe: Recipe }).recipe, applied: [] };
    if (command === "generation.pending") return [];
    if (command === "generation.list") return [];
    return {};
  });
  const client = { call, subscribe: vi.fn(() => () => undefined) } as unknown as StudioClient;
  return { client, call, calls };
}

async function renderEditor() {
  window.location.hash = "#/recipe/7";
  const client = fakeClient();
  render(<RendererApp client={client.client} />);
  const name = await screen.findByRole("textbox", { name: "Recipe name" });
  return { ...client, name };
}

async function makeDirty() {
  const rendered = await renderEditor();
  fireEvent.change(rendered.name, { target: { value: "Unsaved draft" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
  return rendered;
}

afterEach(async () => {
  await changeLanguage("en");
  window.location.hash = "";
});

describe("unsaved recipe protection", () => {
  it("keeps the draft when sidebar navigation is cancelled", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      const { name } = await makeDirty();
      fireEvent.click(screen.getByRole("button", { name: "Recipes" }));
      await waitFor(() => expect(confirm).toHaveBeenCalled());
      expect(window.location.hash).toBe("#/recipe/7");
      expect(name).toHaveValue("Unsaved draft");
    } finally {
      confirm.mockRestore();
    }
  });

  it("restores the accepted hash when an external route change is cancelled", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      const { name } = await makeDirty();
      window.location.hash = "#/settings";
      await waitFor(() => expect(confirm).toHaveBeenCalled());
      await waitFor(() => expect(window.location.hash).toBe("#/recipe/7"));
      expect(name).toHaveValue("Unsaved draft");
      expect(screen.getByRole("textbox", { name: "Recipe name" })).toBeInTheDocument();
    } finally {
      confirm.mockRestore();
    }
  });

  it("leaves the editor after explicit discard confirmation", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      await makeDirty();
      fireEvent.click(screen.getByRole("button", { name: "Recipes" }));
      await screen.findByRole("heading", { name: "Recipes" });
      expect(window.location.hash).toBe("#/recipes");
      expect(screen.queryByRole("textbox", { name: "Recipe name" })).not.toBeInTheDocument();
    } finally {
      confirm.mockRestore();
    }
  });

  it("does not prompt after the draft has been saved", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      const { call } = await makeDirty();
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(call).toHaveBeenCalledWith("recipes.save", expect.objectContaining({ recipe: expect.objectContaining({ name: "Unsaved draft" }) })));
      await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeDisabled());
      fireEvent.click(screen.getByRole("button", { name: "Recipes" }));
      await screen.findByRole("heading", { name: "Recipes" });
      expect(confirm).not.toHaveBeenCalled();
    } finally {
      confirm.mockRestore();
    }
  });

  it("saves the draft before transferring it to generation", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      const { call } = await makeDirty();
      fireEvent.click(within(screen.getByRole("region", { name: "Recipe details" })).getByRole("button", { name: "Generate" }));
      await waitFor(() => expect(call).toHaveBeenCalledWith("recipes.save", expect.objectContaining({ recipe: expect.objectContaining({ name: "Unsaved draft" }) })));
      await screen.findByRole("heading", { name: "Generate" });
      expect(window.location.hash).toBe("#/generate");
      expect(confirm).not.toHaveBeenCalled();
    } finally {
      confirm.mockRestore();
    }
  });

  it("blocks beforeunload while the editor has unsaved changes", async () => {
    const { name } = await makeDirty();
    const cleanEvent = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanEvent);
    expect(cleanEvent.defaultPrevented).toBe(true);
    expect(name).toHaveValue("Unsaved draft");
  });
});
