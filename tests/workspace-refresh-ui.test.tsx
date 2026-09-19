import * as React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import type { StudioClient, StudioEvent, StoredCharacter, StoredPreset } from "../contracts/studio";
import { i18n, changeLanguage } from "../i18n";
import { CharactersFeature } from "../features/characters/CharactersFeature";
import { PaletteFeature } from "../features/palette/PaletteFeature";
import { RecipesFeature } from "../features/recipes/RecipesFeature";
import { newBlock, newRecipe, type RecipeSummary } from "../features/shared/types";

function renderWithI18n(element: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{element}</I18nextProvider>);
}

function refreshClient() {
  let recipes: RecipeSummary[] = [];
  let presets: StoredPreset[] = [];
  let characters: StoredCharacter[] = [];
  const listeners = new Set<(event: StudioEvent) => void>();
  const call = vi.fn(async (command: string) => {
    if (command === "recipes.list") return { items: recipes, total: recipes.length };
    if (command === "presets.list") return { items: presets, total: presets.length };
    if (command === "characters.list") return { items: characters, total: characters.length };
    if (command === "gallery.list") return { items: [], total: 0 };
    if (command === "settings.get") return { blurSensitive: false };
    return {};
  });
  const client = {
    call,
    subscribe: vi.fn((listener: (event: StudioEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  } as unknown as StudioClient;
  return {
    client,
    call,
    setRecipes(value: RecipeSummary[]) { recipes = value; },
    setPresets(value: StoredPreset[]) { presets = value; },
    setCharacters(value: StoredCharacter[]) { characters = value; },
    emit(event: StudioEvent) { for (const listener of listeners) listener(event); },
  };
}

afterEach(async () => {
  await changeLanguage("en");
  window.location.hash = "";
});

describe("workspace change refreshes external library writes", () => {
  it("refreshes recipes after an external recipe event", async () => {
    const fixture: RecipeSummary = { ...newRecipe("External recipe"), id: 21, version: 1, created_at: "2026-09-20T09:00:00.000Z", updated_at: "2026-09-20T09:00:00.000Z" };
    const { client, call, setRecipes, emit } = refreshClient();
    renderWithI18n(<RecipesFeature client={client} onOpenRecipe={vi.fn()} onOpenGeneration={vi.fn()} />);

    await waitFor(() => expect(call).toHaveBeenCalledWith("recipes.list", expect.anything()));
    setRecipes([fixture]);
    await act(async () => emit({ type: "workspace.changed", entity: "recipes" }));

    expect(await screen.findByText("External recipe")).toBeInTheDocument();
    expect(call.mock.calls.filter(([command]) => command === "recipes.list")).toHaveLength(2);
  });

  it("refreshes palette presets after an external preset event", async () => {
    const fixture: StoredPreset = { id: 22, type: "scene", name: "External preset", block: newBlock("scene"), tags: [], notes: "", created_at: "2026-09-20T09:00:00.000Z", updated_at: "2026-09-20T09:00:00.000Z" };
    const { client, call, setPresets, emit } = refreshClient();
    renderWithI18n(<PaletteFeature client={client} />);

    await waitFor(() => expect(call).toHaveBeenCalledWith("presets.list", expect.anything()));
    setPresets([fixture]);
    await act(async () => emit({ type: "workspace.changed", entity: "presets" }));

    expect(await screen.findByText("External preset")).toBeInTheDocument();
    expect(call.mock.calls.filter(([command]) => command === "presets.list")).toHaveLength(2);
  });

  it("refreshes characters after an external character event", async () => {
    const fixture: StoredCharacter = { id: 23, tag: "external_character", series: "", display_name: "", gender: "girl", age_flag: "unknown", locked: false, fixed_traits: [], default_x: 0.5, default_y: 0.5, notes: "", created_at: "2026-09-20T09:00:00.000Z" };
    const { client, call, setCharacters, emit } = refreshClient();
    renderWithI18n(<CharactersFeature client={client} />);

    await waitFor(() => expect(call).toHaveBeenCalledWith("characters.list", expect.anything()));
    setCharacters([fixture]);
    await act(async () => emit({ type: "workspace.changed", entity: "characters" }));

    expect(await screen.findByText("external_character")).toBeInTheDocument();
    expect(call.mock.calls.filter(([command]) => command === "characters.list")).toHaveLength(2);
  });
});
