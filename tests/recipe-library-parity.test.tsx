import * as React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { changeLanguage } from "../i18n";
import { RecipesFeature } from "../features/recipes/RecipesFeature";
import { newRecipe } from "../features/shared/types";
import type { GalleryItem, StudioClient, StoredRecipe } from "../contracts/studio";

function fixture() {
  const recipe = { ...newRecipe("Synthetic recipe"), id: 3, version: 1, created_at: "2026-09-18 09:00:00", updated_at: "2026-09-18 10:00:00", generation_count: 12 } as StoredRecipe;
  recipe.latest = { id: 4, recipe_id: 3, recipe_name: recipe.name, recipe, seed: 12, width: 512, height: 768, rating: 0, url: "data:image/png;base64,synthetic", created_at: "2026-09-20 13:20:00", estimatedAnlas: 0, score: null, liked: false, note: "", base_prompt: "", negative: "" } as GalleryItem;
  const call = vi.fn(async (command: string, input: Record<string, unknown>) => {
    if (command === "recipes.list") return { items: [recipe], total: 1 };
    if (command === "settings.get") return { blurSensitive: false };
    if (command === "recipes.save") return { ...input.recipe as object, id: 8, version: 1 };
    throw new Error(command);
  });
  const client = { call, subscribe: () => () => undefined } as unknown as StudioClient;
  return { client, call };
}

beforeEach(async () => { await changeLanguage("en"); });

describe("recipe library parity", () => {
  it("applies the selected default style and a dated name when creating a recipe", async () => {
    const { client, call } = fixture();
    const block = { type: "style", artists: [], year: "", quality: ["synthetic quality"], minus: [] };
    localStorage.setItem("studio.default_style", JSON.stringify({ name: "Synthetic default", block }));
    render(<RecipesFeature client={client} onOpenRecipe={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "New recipe" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("recipes.save", expect.objectContaining({ recipe: expect.objectContaining({ name: expect.stringMatching(/^New recipe \d{2}-\d{2} \d{2}:\d{2}$/), blocks: expect.arrayContaining([block]) }) })));
  });

  it("restores table and sort preferences and shows the latest image and generation count", async () => {
    const { client } = fixture();
    localStorage.setItem("studio.recipes.view", "table");
    localStorage.setItem("studio.recipes.sort", "oldest");
    render(<RecipesFeature client={client} onOpenRecipe={vi.fn()} />);
    const table = await screen.findByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Latest generation" })).toBeInTheDocument();
    expect(within(table).getByText("2026-09-20 13:20 · 12 images")).toBeInTheDocument();
    expect(table.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,synthetic");
    expect(screen.getByRole("combobox", { name: "Sort" })).toHaveTextContent("Oldest");
  });

  it("retains the chosen view after leaving and returning to the library", async () => {
    const { client } = fixture();
    const props = { client, onOpenRecipe: vi.fn() };
    const mounted = render(<RecipesFeature {...props} />);
    await screen.findByText("Synthetic recipe");
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    mounted.unmount();
    render(<RecipesFeature {...props} />);
    expect(await screen.findByRole("table")).toBeInTheDocument();
  });
});
