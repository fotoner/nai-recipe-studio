import * as React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { StudioClient } from "../contracts/studio";
import { RecipeEditorFeature } from "../features/recipe-editor/RecipeEditorFeature";
import { newRecipe } from "../features/shared/types";
import { changeLanguage } from "../i18n";

function fixture() {
  const recipe = { ...newRecipe("Original"), id: 7, version: 1 };
  const call = vi.fn(async (command: string, input: Record<string, unknown>) => {
    if (command === "recipes.get") return recipe;
    if (command.endsWith(".list")) return { items: [], total: 0 };
    if (command === "settings.get") return { blurSensitive: false };
    if (command === "recipe.compose") return { settings: {}, base_prompt: "", negative: "", characters: [], rating: 0 };
    if (command === "recipe.validate") return { recipe: input.recipe, findings: [], applied: [] };
    if (command === "recipes.save") return { ...input.recipe as object, id: 7, version: 2 };
    return {};
  });
  return { client: { call, subscribe: () => () => undefined } as unknown as StudioClient, call };
}
beforeEach(async () => { await changeLanguage("en"); });
it("undoes and redoes recipe edits without saving, then saves with the keyboard", async () => {
  const { client, call } = fixture();
  render(<RecipeEditorFeature client={client} recipeId={7} onBack={vi.fn()} />);
  const name = await screen.findByRole("textbox", { name: "Recipe name" });
  fireEvent.change(name, { target: { value: "Changed" } });
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(name).toHaveValue("Original");
  fireEvent.click(screen.getByRole("button", { name: "Redo" }));
  expect(name).toHaveValue("Changed");
  expect(call).not.toHaveBeenCalledWith("recipes.save", expect.anything());
  fireEvent.keyDown(window, { key: "s", ctrlKey: true });
  await waitFor(() => expect(call).toHaveBeenCalledWith("recipes.save", expect.objectContaining({ expectedVersion: 1, recipe: expect.objectContaining({ name: "Changed" }) })));
  await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeDisabled());
});
it("offers a persisted unsaved draft on remount, leaving the saved recipe intact until recovery", async () => {
  const { client, call } = fixture();
  const view = render(<RecipeEditorFeature client={client} recipeId={7} onBack={vi.fn()} />);
  fireEvent.change(await screen.findByRole("textbox", { name: "Recipe name" }), { target: { value: "Recovered work" } });
  view.unmount();
  render(<RecipeEditorFeature client={client} recipeId={7} onBack={vi.fn()} />);
  const name = await screen.findByRole("textbox", { name: "Recipe name" });
  expect(name).toHaveValue("Original");
  fireEvent.click(await screen.findByRole("button", { name: "Recover draft" }));
  expect(name).toHaveValue("Recovered work");
  expect(call).not.toHaveBeenCalledWith("recipes.save", expect.anything());
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeDisabled());
});
it("does not lose edits made while an earlier save is pending", async () => {
  const { client, call } = fixture();
  const original = client.call;
  let finish!: (value: unknown) => void;
  client.call = ((command: string, input: unknown) => command === "recipes.save" ? new Promise<unknown>(resolve => { finish = resolve; }) : original(command as never, input as never)) as StudioClient["call"];
  render(<RecipeEditorFeature client={client} recipeId={7} onBack={vi.fn()} />);
  const name = await screen.findByRole("textbox", { name: "Recipe name" });
  fireEvent.change(name, { target: { value: "Saving version" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  fireEvent.change(name, { target: { value: "Later edits" } });
  await act(async () => finish({ ...newRecipe("Saving version"), id: 7, version: 2 }));
  expect(name).toHaveValue("Later edits");
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  expect(call).not.toHaveBeenCalledWith("recipes.save", expect.anything());
});
it("uses the original bidirectional replacement icon and ordinary save icon", async () => {
  render(<RecipeEditorFeature client={fixture().client} recipeId={7} onBack={vi.fn()} />);
  await screen.findByRole("textbox", { name: "Recipe name" });
  for (const button of screen.getAllByRole("button", { name: "Replace" })) expect(button.querySelector("svg")).toHaveClass("lucide-arrow-left-right");
  expect(screen.getByRole("button", { name: "Scene Save to palette" }).querySelector("svg")).toHaveClass("lucide-save");
});
it("recovers an older draft as a separate recipe when its saved version has changed", async () => {
  const { client, call } = fixture();
  const first = render(<RecipeEditorFeature client={client} recipeId={7} onBack={vi.fn()} />);
  fireEvent.change(await screen.findByRole("textbox", { name: "Recipe name" }), { target: { value: "Old draft" } });
  first.unmount();
  const original = client.call;
  client.call = ((command: string, input: unknown) => command === "recipes.get" ? Promise.resolve({ ...newRecipe("New saved version"), id: 7, version: 2 }) : original(command as never, input as never)) as StudioClient["call"];
  render(<RecipeEditorFeature client={client} recipeId={7} onBack={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Recover as new recipe" }));
  expect(screen.getByRole("textbox", { name: "Recipe name" })).toHaveValue("Old draft");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(call).toHaveBeenCalledWith("recipes.save", expect.objectContaining({ expectedVersion: undefined, recipe: expect.objectContaining({ id: undefined, name: "Old draft" }) })));
});
it("commits the active tag field before keyboard saving", async () => {
  const { client, call } = fixture();
  render(<RecipeEditorFeature client={client} recipeId={7} onBack={vi.fn()} />);
  await screen.findByRole("textbox", { name: "Recipe name" });
  const tags = screen.getByRole("textbox", { name: "Tags" });
  act(() => tags.focus());
  fireEvent.change(tags, { target: { value: "new tag" } });
  fireEvent.keyDown(tags, { key: "s", metaKey: true });
  await waitFor(() => expect(call).toHaveBeenCalledWith("recipes.save", expect.objectContaining({ recipe: expect.objectContaining({ tags: ["new tag"] }) })));
});
it("rebases undo history onto the newly saved version", async () => {
  const { client, call } = fixture();
  render(<RecipeEditorFeature client={client} recipeId={7} onBack={vi.fn()} />);
  fireEvent.change(await screen.findByRole("textbox", { name: "Recipe name" }), { target: { value: "Saved change" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeDisabled());
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(screen.getByRole("textbox", { name: "Recipe name" })).toHaveValue("Original");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(call).toHaveBeenCalledWith("recipes.save", expect.objectContaining({ expectedVersion: 2, recipe: expect.objectContaining({ name: "Original" }) })));
});
it("keeps editing available and warns when recovery storage fails", async () => {
  const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Quota exceeded", "QuotaExceededError"); });
  try {
    render(<RecipeEditorFeature client={fixture().client} recipeId={7} onBack={vi.fn()} />);
    const name = await screen.findByRole("textbox", { name: "Recipe name" });
    fireEvent.change(name, { target: { value: "Keep this work" } });
    expect(name).toHaveValue("Keep this work");
    expect(await screen.findByRole("alert")).toHaveTextContent("The recovery draft could not be stored");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  } finally { setItem.mockRestore(); }
});
it("does not navigate back to a new recipe after the editor has been left during saving", async () => {
  const { client } = fixture();
  const original = client.call;
  let finish!: (value: unknown) => void;
  client.call = ((command: string, input: unknown) => command === "recipes.save" ? new Promise<unknown>(resolve => { finish = resolve; }) : original(command as never, input as never)) as StudioClient["call"];
  const onSaved = vi.fn();
  const view = render(<RecipeEditorFeature client={client} draftId="new-draft" initialRecipe={newRecipe("New draft")} onSaved={onSaved} onBack={vi.fn()} />);
  await screen.findByRole("textbox", { name: "Recipe name" });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  view.unmount();
  await act(async () => finish({ ...newRecipe("New draft"), id: 8, version: 1 }));
  expect(onSaved).not.toHaveBeenCalled();
});
it("reopens the latest image draft after leaving the editor within the same app session", async () => {
  const { client } = fixture();
  const initialRecipe = newRecipe("Initial image snapshot");
  const first = render(<RecipeEditorFeature client={client} draftId="fixture-image" initialRecipe={initialRecipe} onBack={vi.fn()} />);
  fireEvent.change(await screen.findByRole("textbox", { name: "Recipe name" }), { target: { value: "Edited image draft" } });
  first.unmount();
  render(<RecipeEditorFeature client={client} draftId="fixture-image" initialRecipe={initialRecipe} onBack={vi.fn()} />);
  expect(await screen.findByRole("textbox", { name: "Recipe name" })).toHaveValue("Edited image draft");
});
