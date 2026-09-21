import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCommandInput, type Command, type GalleryItem, type StudioClient } from "../contracts/studio";
import { changeLanguage } from "../i18n";
import { GalleryFeature } from "../features/gallery/GalleryFeature";
import { GenerationResults } from "../features/generation/GenerationResults";
import type { GenerationDraftFromImage } from "../core/recipe/from-generation";
import { newRecipe } from "../features/shared/types";
import { SettingsBlock } from "../lib/schema";

function storedItem(): GalleryItem {
  const recipe = { ...newRecipe("Synthetic snapshot"), id: 7, version: 3 };
  const settings = SettingsBlock.parse({ type: "settings", width: 832, height: 1216, steps: 28, seed_policy: "random" });
  return {
    id: 321, recipe_id: 7, recipe_name: recipe.name, recipe, seed: 171, width: 832, height: 1216, rating: 0,
    url: "file:///synthetic/generated.png", created_at: "2026-09-20T10:00:00.000Z", estimatedAnlas: 0,
    score: null, liked: false, note: "", base_prompt: "synthetic prompt", negative: "synthetic negative", characters: [], settings,
  };
}

function fakeClient(item = storedItem()) {
  const call = vi.fn(async (command: string, input: unknown) => {
    parseCommandInput(command as Command, input);
    if (command === "gallery.list") return { items: [item], total: 1 };
    if (command === "recipes.list" || command === "characters.list" || command === "presets.list") return { items: [], total: 0 };
    if (command === "gallery.rate") return { ...item, ...(input as object) };
    if (command === "gallery.export") return { saved: true };
    return {};
  });
  return { client: { call, subscribe: vi.fn(() => () => undefined) } as unknown as StudioClient };
}

afterEach(async () => { await changeLanguage("en"); });

describe("continue from a generation snapshot", () => {
  it("passes a same-seed draft from the gallery lightbox", async () => {
    await changeLanguage("en");
    const item = storedItem();
    const { client } = fakeClient(item);
    const onContinueFromGeneration = vi.fn<(draft: GenerationDraftFromImage) => void>();
    render(<GalleryFeature client={client} blurSensitive={false} onOpenRecipe={vi.fn()} onContinueFromGeneration={onContinueFromGeneration} />);

    fireEvent.click(await screen.findByTitle("Enlarge"));
    fireEvent.click(await screen.findByRole("button", { name: "Continue with the same seed" }));

    expect(onContinueFromGeneration).toHaveBeenCalledWith(expect.objectContaining({ sourceGenerationId: 321, seedMode: "same", recipe: expect.objectContaining({ name: "Synthetic snapshot" }) }));
    expect(onContinueFromGeneration.mock.calls[0]?.[0].recipe.id).toBeUndefined();
  });

  it("passes a new-seed draft from generated results", async () => {
    await changeLanguage("en");
    const item = storedItem();
    const onContinueFromGeneration = vi.fn<(draft: GenerationDraftFromImage) => void>();
    render(<GenerationResults items={[item]} onContinueFromGeneration={onContinueFromGeneration} />);

    fireEvent.click(screen.getByRole("button", { name: "Open image 321" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue with a new seed" }));

    await waitFor(() => expect(onContinueFromGeneration).toHaveBeenCalledWith(expect.objectContaining({ sourceGenerationId: 321, seedMode: "new" })));
    expect(onContinueFromGeneration.mock.calls[0]?.[0].recipe.id).toBeUndefined();
  });
});
