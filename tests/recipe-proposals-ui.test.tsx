import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecipeProposal } from "../contracts/proposals";
import type { StudioClient, StoredRecipe } from "../contracts/studio";
import { changeLanguage } from "../i18n";
import { makeCharacter, makeRecipe } from "../core/recipe/model";
import { RecipeProposals } from "../features/recipe-editor/RecipeProposals";

const initialRecipe = {
  ...makeRecipe("Original", [{ type: "scene", tags: ["indoors"], text: "" }]),
  id: 7,
  version: 1,
  created_at: "2026-09-20T10:00:00.000Z",
  updated_at: "2026-09-20T10:00:00.000Z",
} satisfies StoredRecipe;

const initialProposal: RecipeProposal = {
  id: "proposal-1",
  recipeId: initialRecipe.id,
  baseVersion: 1,
  applicationVersion: 1,
  reason: "Clarify the setting.",
  connectionId: "mcp-one",
  connectionName: "MCP one",
  createdAt: "2026-09-20T10:00:00.000Z",
  updatedAt: "2026-09-20T10:00:00.000Z",
  expiresAt: "2026-09-27T10:00:00.000Z",
  status: "pending",
  changes: [
    { id: "name-change", scope: "metadata", field: "name", before: "Original", after: "Proposed", state: "pending" },
    { id: "scene-change", scope: "block", index: 0, blockType: "scene", before: { type: "scene", tags: ["indoors"], text: "" }, after: { type: "scene", tags: ["outdoors"], text: "" }, state: "pending" },
  ],
};

function makeClient(firstProposal: RecipeProposal = initialProposal) {
  let proposal = firstProposal;
  const call = vi.fn(async (command: string, input: unknown): Promise<unknown> => {
    if (command === "recipes.proposals.list") return [proposal];
    if (command === "recipes.proposals.apply") {
      const request = input as { changeIds: string[] };
      proposal = {
        ...proposal,
        applicationVersion: 2,
        status: "partial",
        changes: proposal.changes.map(change => request.changeIds.includes(change.id) ? { ...change, state: "applied" } as RecipeProposal["changes"][number] : change),
      };
      return { proposal, recipe: { ...initialRecipe, name: "Proposed", version: 2 } };
    }
    return {};
  });
  const client = { call, subscribe: vi.fn(() => () => undefined) } as unknown as StudioClient;
  return { client, call };
}

afterEach(async () => { await changeLanguage("en"); });

describe("recipe proposal review panel", () => {
  it("shows readable diffs and applies only the selected change before notifying the editor", async () => {
    await changeLanguage("en");
    const { client, call } = makeClient();
    const onApplied = vi.fn();
    render(<RecipeProposals client={client} recipeId={initialRecipe.id} onApplied={onApplied} />);

    expect(await screen.findByText("Clarify the setting.")).toBeInTheDocument();
    expect(screen.getByText(/Tags: indoors/)).toBeInTheDocument();
    expect(screen.getByText(/Tags: outdoors/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select change: Recipe name" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply selected" }));

    await waitFor(() => expect(call).toHaveBeenCalledWith("recipes.proposals.apply", {
      proposalId: "proposal-1",
      changeIds: ["name-change"],
      expectedVersion: 1,
    }));
    await waitFor(() => expect(onApplied).toHaveBeenCalledWith(expect.objectContaining({ name: "Proposed", version: 2 })));
  });

  it("keeps pending changes visible but blocks actions while the editor has unsaved changes", async () => {
    await changeLanguage("en");
    const { client } = makeClient();
    render(<RecipeProposals client={client} recipeId={initialRecipe.id} disabled />);

    expect(await screen.findByRole("status")).toHaveTextContent("Save or discard your recipe changes before applying a proposal.");
    expect(screen.getByRole("button", { name: "Apply selected" })).toBeDisabled();
  });

  it("shows cast character snapshot fields and isolation changes even when the display name is unchanged", async () => {
    await changeLanguage("en");
    const beforeCharacter = makeCharacter({ id: 23, tag: "sample_original", series: "Synthetic series", display_name: "Same display name", age_flag: "adult", fixed_traits: ["short hair"] });
    const afterCharacter = makeCharacter({ id: 23, tag: "sample_variant", series: "Synthetic series", display_name: "Same display name", age_flag: "adult", fixed_traits: ["short hair", "blue eyes"] });
    const member = { character_id: 23, x: 0.5, y: 0.5, traits: [], outfit: [], expression: [], uc: [], interactions: [] };
    const proposal: RecipeProposal = {
      ...initialProposal,
      changes: [{
        id: "cast-snapshot-change",
        scope: "block",
        index: 0,
        blockType: "cast",
        before: { type: "cast", members: [{ ...member, character_snapshot: beforeCharacter }], layout_preset: "solo", auto_leak_guard: true },
        after: { type: "cast", members: [{ ...member, character_snapshot: afterCharacter }], layout_preset: "solo", auto_leak_guard: false },
        state: "pending",
      }],
    };
    const { client } = makeClient(proposal);
    render(<RecipeProposals client={client} recipeId={initialRecipe.id} />);

    await screen.findByText("Clarify the setting.");
    const visible = document.body.textContent ?? "";
    expect(visible).toContain("Character tag: sample_original");
    expect(visible).toContain("Character tag: sample_variant");
    expect(visible).toContain("Fixed traits: short hair");
    expect(visible).toContain("Fixed traits: short hair, blue eyes");
    expect(visible).toContain("Character detail isolation: Enabled");
    expect(visible).toContain("Character detail isolation: Disabled");
  });
});
