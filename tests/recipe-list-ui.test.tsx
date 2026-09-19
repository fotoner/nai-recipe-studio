import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { StudioClient } from "../contracts/studio";
import { RecipesFeature } from "../features/recipes/RecipesFeature";
import { newRecipe } from "../features/shared/types";

it("shows later library pages and applies only selected lint fixes with the inspected version", async () => {
  const recipes = [1, 2, 3].map(id => ({ ...newRecipe(`Sample ${id}`), id, version: 4, created_at: "2026-09-20T00:00:00Z", updated_at: "2026-09-20T00:00:00Z" }));
  const call = vi.fn(async (command: string, input: Record<string, unknown>) => {
    if (command === "recipes.list") return { items: input.offset === 0 ? recipes.slice(0, 2) : recipes.slice(2), total: 3 };
    if (command === "settings.get") return { blurSensitive: false };
    if (command === "recipe.validate") {
      const recipe = input.recipe as typeof recipes[0];
      return { recipe, findings: recipe.id === 3 && !input.fixes ? [{ code: "STYLE_MINUS", messageKey: "validation.styleMinus", severity: "warn", fixable: true }] : [], applied: input.fixes ?? [] };
    }
    if (command === "recipes.save") return { ...(input.recipe as object), version: 5 };
    throw new Error(command);
  });
  const client = { call, subscribe: () => () => undefined } as unknown as StudioClient;
  render(<RecipesFeature client={client} onOpenRecipe={vi.fn()} onOpenGeneration={vi.fn()} />);
  expect(await screen.findByText("Sample 3")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Check" }));
  fireEvent.click(await screen.findByRole("button", { name: "Select all (1)" }));
  fireEvent.click(screen.getByRole("button", { name: "Apply selected fixes" }));
  await waitFor(() => expect(call).toHaveBeenCalledWith("recipes.save", expect.objectContaining({ recipe: expect.objectContaining({ id: 3 }), expectedVersion: 4 })));
  expect(call.mock.calls.filter(([command]) => command === "recipes.save")).toHaveLength(1);
});
