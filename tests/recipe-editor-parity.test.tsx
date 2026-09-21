import * as React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StudioClient, StudioEvent } from "../contracts/studio";
import { RecipeEditorFeature } from "../features/recipe-editor/RecipeEditorFeature";
import { newRecipe } from "../features/shared/types";
import { changeLanguage } from "../i18n";

function fixture() {
  const listeners = new Set<(event: StudioEvent) => void>();
  const recipe = { ...newRecipe("Synthetic editor"), id: 7, version: 1 };
  const call = vi.fn(async (command: string, input: Record<string, unknown>) => {
    if (command === "recipes.get") return recipe;
    if (command === "characters.list") return { items: [{ id: input.offset === 0 ? 1 : 201, display_name: input.offset === 0 ? "First character" : "Last character", tag: "synthetic", series: "", gender: "girl", age_flag: "adult", locked: false, fixed_traits: [], default_x: 0.5, default_y: 0.5, notes: "" }], total: 2 };
    if (command === "presets.list") return { items: [{ id: input.offset === 0 ? 1 : 201, type: "style", name: "Synthetic style", block: { type: "style", artists: [], year: "", quality: [], minus: [] }, tags: [], notes: "" }], total: 2 };
    if (command === "settings.get") return { blurSensitive: false };
    if (command === "gallery.list") return { items: [], total: 0 };
    if (command === "recipe.compose") return { settings: {} , base_prompt: "", negative: "", characters: [], rating: 0 };
    if (command === "recipe.validate") return { findings: [], recipe: input.recipe, applied: [] };
    return {};
  });
  const client = { call, subscribe: (listener: (event: StudioEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); } } as unknown as StudioClient;
  const emit = (event: StudioEvent) => act(() => listeners.forEach(listener => listener(event)));
  return { client, call, emit };
}

beforeEach(async () => { await changeLanguage("en"); });
describe("original recipe editor behavior", () => {
  it("keeps the character block fixed and blocks generation until a character is added", async () => {
    const { client, call } = fixture();
    render(<RecipeEditorFeature client={client} recipeId={7} onBack={vi.fn()} />);
    await screen.findByRole("textbox", { name: "Recipe name" });
    expect(screen.queryByRole("button", { name: "Characters Block menu" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(call).not.toHaveBeenCalledWith("generation.prepare", expect.anything());
  });

  it("loads all available character and preset pages for the editor", async () => {
    const { client, call } = fixture();
    render(<RecipeEditorFeature client={client} recipeId={7} onBack={vi.fn()} />);
    await screen.findByRole("textbox", { name: "Recipe name" });
    expect(call).toHaveBeenCalledWith("characters.list", { limit: 200, offset: 1 });
    expect(call).toHaveBeenCalledWith("presets.list", { limit: 200, offset: 1, includeHidden: false });
  });

  it("refreshes recipe history when a new gallery image is saved", async () => {
    const { client, call, emit } = fixture();
    render(<RecipeEditorFeature client={client} recipeId={7} onBack={vi.fn()} />);
    await screen.findByRole("textbox", { name: "Recipe name" });
    await waitFor(() => expect(call.mock.calls.filter(([name]) => name === "gallery.list")).toHaveLength(1));
    emit({ type: "workspace.changed", entity: "gallery" });
    await waitFor(() => expect(call.mock.calls.filter(([name]) => name === "gallery.list")).toHaveLength(2));
  });
});
