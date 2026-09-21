import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CallContext } from "../contracts/studio";
import { createStudioService } from "../services/studio";
import { makeRecipe } from "../core/recipe/model";

const connection: NonNullable<CallContext["connection"]> = {
  id: "proposal-owner",
  name: "Proposal owner",
  permissions: { read: true, write: true, generate: false, images: false },
  maxImages: 0,
  maxAnlas: 0,
  created_at: "2026-09-20T00:00:00.000Z",
};

describe("AI recipe proposals", () => {
  it("creates a version-bound diff, selectively applies it once, and undoes selected changes", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "nai-recipe-proposals-"));
    const service = createStudioService({ dataDir, getToken: async () => null, dryRun: true });
    const client = service;
    const owner: CallContext = { source: "mcp", connection };
    try {
      const original = await service.call("recipes.save", { recipe: makeRecipe("Original", [{ type: "scene", tags: ["indoors"], text: "" }]) });
      const proposed = { ...original, name: "Proposed", notes: "A neutral change proposal", blocks: [{ type: "scene" as const, tags: ["outdoors"], text: "" }] };
      const proposal = await client.call("recipes.proposals.create", { recipeId: original.id, expectedVersion: original.version, proposedRecipe: proposed, reason: "Clarify the setting and document the revision." }, owner);

      expect(proposal).toMatchObject({ recipeId: original.id, baseVersion: 1, applicationVersion: 1, status: "pending", connectionId: connection.id });
      expect(await service.call("recipes.get", { id: original.id })).toMatchObject({ name: "Original", version: 1, notes: "" });
      expect(proposal.changes.map(change => `${change.scope}:${change.scope === "metadata" ? change.field : change.scope === "block" ? change.index : "all"}`).sort()).toEqual(["block:0", "metadata:name", "metadata:notes"]);
      expect(await client.call("recipes.proposals.list", { recipeId: original.id }, { source: "mcp", connection: { ...connection, id: "other-owner" } })).toEqual([]);

      const nameChange = proposal.changes.find(change => change.scope === "metadata" && change.field === "name");
      const blockChange = proposal.changes.find(change => change.scope === "block");
      const notesChange = proposal.changes.find(change => change.scope === "metadata" && change.field === "notes");
      if (!nameChange || !blockChange || !notesChange) throw new Error("Expected the proposal to contain all three changes.");
      const selected = await client.call("recipes.proposals.apply", { proposalId: proposal.id, changeIds: [nameChange.id], expectedVersion: 1 }, { source: "ui" });
      expect(selected.recipe).toMatchObject({ name: "Proposed", notes: "", version: 2 });
      expect(selected.proposal.status).toBe("partial");

      const replay = await client.call("recipes.proposals.apply", { proposalId: proposal.id, changeIds: [nameChange.id], expectedVersion: 1 }, { source: "ui" });
      expect(replay.recipe.version).toBe(2);
      expect((await service.call("recipes.versions", { id: original.id })).map(item => item.version)).toEqual([2, 1]);

      const remainder = await client.call("recipes.proposals.apply", { proposalId: proposal.id, changeIds: [blockChange.id, notesChange.id], expectedVersion: 2 }, { source: "ui" });
      expect(remainder.recipe).toMatchObject({ version: 3, notes: "A neutral change proposal" });
      expect(remainder.recipe.blocks[0]).toMatchObject({ type: "scene", tags: ["outdoors"] });

      const undone = await client.call("recipes.proposals.undo", { proposalId: proposal.id, changeIds: [blockChange.id], expectedVersion: 3 }, { source: "ui" });
      expect(undone.recipe).toMatchObject({ version: 4, name: "Proposed", notes: "A neutral change proposal" });
      expect(undone.recipe.blocks[0]).toMatchObject({ type: "scene", tags: ["indoors"] });
      expect((await service.call("recipes.versions", { id: original.id })).map(item => item.version)).toEqual([4, 3, 2, 1]);
    } finally {
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("rejects stale, foreign, expired, and MCP-applied proposals", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "nai-recipe-proposals-"));
    const service = createStudioService({ dataDir, getToken: async () => null, dryRun: true });
    const client = service;
    try {
      const original = await service.call("recipes.save", { recipe: makeRecipe("Conflict target", [{ type: "scene", tags: ["indoors"], text: "" }]) });
      await expect(client.call("recipes.proposals.create", { recipeId: original.id, expectedVersion: 2, proposedRecipe: { ...original, name: "Stale proposal" }, reason: "Must match current version." }, { source: "mcp", connection }))
        .rejects.toMatchObject({ data: { code: "VERSION_CONFLICT" } });
      const proposal = await client.call("recipes.proposals.create", { recipeId: original.id, expectedVersion: 1, proposedRecipe: { ...original, name: "AI edit" }, reason: "A synthetic review." }, { source: "mcp", connection });
      const otherOwner = await client.call("recipes.proposals.list", {}, { source: "mcp", connection: { ...connection, id: "unrelated" } });
      expect(otherOwner).toEqual([]);
      const writeOnly = { ...connection, id: "write-only", permissions: { read: false, write: true, generate: false, images: false } };
      await expect(client.call("recipes.proposals.create", { recipeId: original.id, expectedVersion: 1, proposedRecipe: { ...original, notes: "Hidden base read" }, reason: "Must also have read permission." }, { source: "mcp", connection: writeOnly }))
        .rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } });
      const readOnly = { ...connection, id: "read-only", permissions: { read: true, write: false, generate: false, images: false } };
      await expect(client.call("recipes.proposals.create", { recipeId: original.id, expectedVersion: 1, proposedRecipe: { ...original, notes: "Write should be denied." }, reason: "Must also have write permission." }, { source: "mcp", connection: readOnly }))
        .rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } });

      await service.call("recipes.save", { recipe: { ...original, notes: "Human edit" }, expectedVersion: 1 });
      await expect(client.call("recipes.proposals.apply", { proposalId: proposal.id, changeIds: [proposal.changes[0].id], expectedVersion: 2 }, { source: "ui" }))
        .rejects.toMatchObject({ data: { code: "VERSION_CONFLICT" } });
      await expect(client.call("recipes.proposals.apply", { proposalId: proposal.id, changeIds: [proposal.changes[0].id], expectedVersion: 2 }, { source: "mcp", connection }))
        .rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } });

      vi.useFakeTimers();
      vi.setSystemTime(new Date(Date.now() + 8 * 24 * 60 * 60 * 1000));
      await expect(client.call("recipes.proposals.apply", { proposalId: proposal.id, changeIds: [proposal.changes[0].id], expectedVersion: 2 }, { source: "ui" }))
        .rejects.toMatchObject({ data: { code: "PROPOSAL_EXPIRED" } });
    } finally {
      vi.useRealTimers();
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
