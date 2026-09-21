import { expect, it, vi } from "vitest";
import { parseCommandInput, type Connection } from "../contracts/studio";
import { CommandDispatcher, type StudioService } from "../desktop/main/command-dispatch";
const connection: Connection = { id: "synthetic", name: "Read only", permissions: { read: true, write: false, images: false, generate: false }, maxImages: 0, maxAnlas: 0, created_at: "2026-09-20T00:00:00Z" };
it("accepts proposal listing through the shared contract", () => {
  expect(parseCommandInput("recipes.proposals.list", { recipeId: 1 })).toEqual({ recipeId: 1 });
});
it("denies MCP application before the recipe service is invoked", async () => {
  const call = vi.fn();
  const dispatcher = new CommandDispatcher({ service: { call } as unknown as StudioService });
  await expect(dispatcher.call("recipes.proposals.apply", { proposalId: "synthetic", changeIds: ["name"], expectedVersion: 1 }, { source: "mcp", connection })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  expect(call).not.toHaveBeenCalled();
});
it("keeps workspace backup paths and restoration behind the app boundary", async () => {
  expect(parseCommandInput("workspace.backup.inspect", {})).toEqual({});
  expect(() => parseCommandInput("workspace.backup.inspect", { path: "/unselected/file" })).toThrow();
  const call = vi.fn();
  const dispatcher = new CommandDispatcher({ service: { call } as unknown as StudioService });
  await expect(dispatcher.call("workspace.backup.export", {}, { source: "mcp", connection })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  expect(call).not.toHaveBeenCalled();
});
