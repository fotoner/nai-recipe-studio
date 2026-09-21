import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StudioClient } from "../contracts/studio";
import { changeLanguage } from "../i18n";
import { RecipeEditorFeature } from "../features/recipe-editor/RecipeEditorFeature";
import { newRecipe, type Recipe } from "../features/shared/types";

function storedRecipe(): Recipe {
  return { ...newRecipe("Naming fixture"), id: 3, version: 1, created_at: "2026-09-20T09:00:00.000Z", updated_at: "2026-09-20T09:00:00.000Z" };
}

function composed() {
  return { base_prompt: "scene", negative: "official art", characters: [], settings: { type: "settings" as const, width: 832, height: 1216, steps: 28, scale: 5, rescale: 0.3, sampler: "k_euler_ancestral", schedule: "karras", seed_policy: "random" as const, quality_preset: "none" as const, uc_preset: "heavy" as const }, rating: 0 };
}

describe("recipe editor source naming", () => {
  afterEach(async () => { await changeLanguage("en"); });

  it("keeps the original compact labels and sends all lint fixes together", async () => {
    await changeLanguage("en");
    const recipe = storedRecipe();
    const calls: Array<[string, unknown]> = [];
    const finding = { code: "STYLE_MINUS", messageKey: "validation.promptSyntax", severity: "warn" as const, fixable: true };
    const call = vi.fn(async (command: string, input: unknown) => {
      calls.push([command, input]);
      if (command === "recipes.get") return recipe;
      if (command === "characters.list" || command === "presets.list") return { items: [], total: 0 };
      if (command === "recipe.compose") return composed();
      if (command === "recipe.validate") {
        const request = input as { fixes?: string[]; recipe: Recipe };
        return request.fixes?.length ? { findings: [], recipe: request.recipe, applied: request.fixes } : { findings: [finding], recipe: request.recipe, applied: [] };
      }
      if (command === "gallery.list") return { items: [], total: 0 };
      if (command === "settings.get") return { blurSensitive: false };
      return {};
    });
    const client = { call, subscribe: vi.fn(() => () => undefined) } as unknown as StudioClient;

    render(<RecipeEditorFeature client={client} recipeId={3} onBack={vi.fn()} />);
    expect(await screen.findByRole("textbox", { name: "Recipe name" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prompt · Lint" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Base" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Characters" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Prompt · Lint" }));
    fireEvent.click(await screen.findByRole("tab", { name: /^Lint(?:\s*\d+)?$/ }));
    expect(await screen.findByText("warn 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fix all (1)" }));
    await waitFor(() => expect(calls).toContainEqual(["recipe.validate", expect.objectContaining({ fixes: ["STYLE_MINUS"] })]));
  });
});
