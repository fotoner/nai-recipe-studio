import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { asPlatformError, errorPayload } from "../main/errors";
import { RpcClient } from "./rpc";
import { BlockPreset, Character, Recipe } from "../../lib/schema";

const EMPTY = {};
const LIST = { query: z.string().max(500).optional(), limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().min(0).optional() };
const GALLERY_LIST = {
  ...LIST,
  recipeId: z.number().int().positive().optional(),
  ratingMax: z.number().int().min(0).max(2).optional(),
  liked: z.boolean().optional(),
  sort: z.enum(["newest", "oldest"]).optional(),
  characterIds: z.array(z.number().int().positive()).max(100).optional(),
  presetIds: z.array(z.number().int().positive()).max(100).optional(),
};

/**
 * Build the official MCP SDK server. Every operation still goes through the
 * authenticated app RPC; the helper never opens the SQLite database or reads
 * credentials itself.
 */
export function createRecipeStudioMcpServer(client: Pick<RpcClient, "request">) {
  const server = new McpServer({ name: "nai-recipe-studio", version: "0.1.0" });
  const tools: Array<{ name: string; command: string; description: string; readOnly: boolean; destructive?: boolean; idempotent?: boolean; inputSchema?: z.ZodType }> = [
    { name: "studio_status", command: "status.read", description: "Read app, schema, connection, and account status.", readOnly: true, inputSchema: z.object({}) },
    { name: "recipes_list", command: "recipes.list", description: "List recipe summaries in the current workspace.", readOnly: true, inputSchema: z.object(LIST) },
    { name: "recipes_get", command: "recipes.get", description: "Read one recipe by ID and version.", readOnly: true, inputSchema: z.object({ id: z.number().int().positive() }) },
    { name: "recipes_save", command: "recipes.save", description: "Save a recipe with optimistic version checking.", readOnly: false, inputSchema: z.object({ recipe: Recipe, expectedVersion: z.number().int().positive().optional(), note: z.string().max(2000).optional() }) },
    { name: "recipe_propose_changes", command: "recipes.proposals.create", description: "Create a version-bound recipe change proposal for the user to review in the app. It does not change the recipe.", readOnly: false, idempotent: false, inputSchema: z.object({ recipeId: z.number().int().positive(), expectedVersion: z.number().int().positive(), proposedRecipe: Recipe, reason: z.string().trim().min(1).max(4000) }) },
    { name: "recipe_proposals_list", command: "recipes.proposals.list", description: "List recipe change proposals owned by this MCP connection, optionally for one recipe.", readOnly: true, inputSchema: z.object({ recipeId: z.number().int().positive().optional() }) },
    { name: "recipes_duplicate", command: "recipes.duplicate", description: "Duplicate one recipe.", readOnly: false, inputSchema: z.object({ id: z.number().int().positive(), name: z.string().min(1).max(200) }) },
    { name: "characters_list", command: "characters.list", description: "List registered characters.", readOnly: true, inputSchema: z.object(LIST) },
    { name: "characters_save", command: "characters.save", description: "Create or update a character while retaining age restrictions.", readOnly: false, inputSchema: z.object({ character: Character }) },
    { name: "presets_list", command: "presets.list", description: "List generic block presets.", readOnly: true, inputSchema: z.object({ ...LIST, type: z.string().optional(), includeHidden: z.boolean().optional() }) },
    { name: "presets_save", command: "presets.save", description: "Save a user-owned block preset.", readOnly: false, inputSchema: z.object({ preset: BlockPreset }) },
    { name: "recipe_compose", command: "recipe.compose", description: "Compose a prompt preview without calling the image API.", readOnly: true, inputSchema: z.object({ recipe: Recipe }) },
    { name: "recipe_validate", command: "recipe.validate", description: "Validate a recipe and return optional fixes without saving.", readOnly: true, inputSchema: z.object({ recipe: Recipe, fixes: z.array(z.string()).max(100).optional() }) },
    { name: "generation_prepare", command: "generation.prepare", description: "Prepare a fixed plan and estimate without generating images. Valid plans within the connection's limits return approved: true and can be started directly.", readOnly: false, inputSchema: z.object({ recipe: Recipe, count: z.number().int().min(1).max(200), seed: z.number().int().min(0).max(4294967295).optional() }) },
    { name: "generation_start", command: "generation.start", description: "Start a plan whose server response has approved: true, including plans approved by connection limits. Permissions and cost are checked again.", readOnly: false, destructive: true, inputSchema: z.object({ planId: z.string().min(1).max(200), requestId: z.string().min(1).max(200) }) },
    { name: "generation_status", command: "generation.status", description: "Read generation job progress.", readOnly: true, inputSchema: z.object({ id: z.string().min(1).max(200) }) },
    { name: "generation_cancel", command: "generation.cancel", description: "Request that a generation job stop before its next request.", readOnly: false, destructive: true, inputSchema: z.object({ id: z.string().min(1).max(200) }) },
    { name: "gallery_list", command: "gallery.list", description: "List selected gallery metadata.", readOnly: true, inputSchema: z.object(GALLERY_LIST) },
    { name: "gallery_get", command: "gallery.get", description: "Read one gallery result's metadata.", readOnly: true, inputSchema: z.object({ id: z.number().int().positive() }) },
    { name: "gallery_rate", command: "gallery.rate", description: "Rate or annotate a selected gallery result.", readOnly: false, inputSchema: z.object({ id: z.number().int().positive(), score: z.number().int().min(0).max(5).nullable().optional(), liked: z.boolean().optional(), note: z.string().max(10000).optional() }) },
  ];

  const registerTool = server.registerTool.bind(server) as unknown as (name: string, config: Record<string, unknown>, callback: (input: Record<string, unknown>) => Promise<unknown>) => unknown;
  for (const tool of tools) {
    registerTool(tool.name, {
      description: tool.description,
      inputSchema: tool.inputSchema as never,
      annotations: { readOnlyHint: tool.readOnly, destructiveHint: tool.destructive ?? false, idempotentHint: tool.idempotent ?? tool.readOnly },
    }, async (input: Record<string, unknown>) => {
      try {
        const result = await client.request(tool.command, input ?? EMPTY);
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: isObject(result) ? result : { value: result } };
      } catch (error) {
        const normalized = asPlatformError(error);
        return { isError: true, content: [{ type: "text", text: JSON.stringify(errorPayload(normalized)) }] };
      }
    });
  }

  registerResources(server, client);
  return server;
}

function registerResources(server: McpServer, client: Pick<RpcClient, "request">) {
  server.registerResource("recipe-schema", "recipe-studio://schema/recipe", { description: "Current recipe contract.", mimeType: "application/json" }, async uri => {
    const value = await client.request("resource.schema", {});
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(value) }] };
  });
  server.registerResource("blocks-guide", "recipe-studio://guide/blocks", { description: "Block and composition guidance.", mimeType: "text/markdown" }, async uri => {
    const value = await client.request("resource.guide.blocks", {});
    return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: typeof value === "string" ? value : JSON.stringify(value) }] };
  });
  server.registerResource("generation-guide", "recipe-studio://guide/generation", { description: "Generation plan, approval, budget, and stop semantics.", mimeType: "text/markdown" }, async uri => {
    const value = await client.request("resource.guide.generation", {});
    return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: typeof value === "string" ? value : JSON.stringify(value) }] };
  });
  server.registerResource("recipe", new ResourceTemplate("recipe-studio://recipes/{id}", { list: undefined }), { description: "A selected recipe from the workspace.", mimeType: "application/json" }, async (uri, variables) => {
    const id = String(variables.id ?? "");
    const value = await client.request("resource.recipe", { id });
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(value) }] };
  });
  server.registerResource("generation-preview", new ResourceTemplate("recipe-studio://generations/{id}/preview", { list: undefined }), { description: "A selected gallery image preview; image permission is required.", mimeType: "image/png" }, async (uri, variables) => {
    const id = String(variables.id ?? "");
    const value = await client.request("resource.generation.preview", { id });
    if (!isObject(value) || typeof value.data !== "string") throw new Error("Invalid image preview response.");
    return {
      contents: [{
        uri: uri.href,
        mimeType: typeof value.mimeType === "string" ? value.mimeType : "image/png",
        blob: value.data,
      }],
    };
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
