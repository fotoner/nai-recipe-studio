import { z } from "zod";
import { Block as BlockSchema, BlockType as BlockTypeSchema, Recipe as RecipeSchema, type Block, type Recipe } from "../lib/schema";
import type { StoredRecipe } from "./studio";

export type ProposalChangeState = "pending" | "applied" | "undone";
export type RecipeProposalChange =
  | { id: string; scope: "metadata"; field: "name" | "source" | "notes"; before: string; after: string; state: ProposalChangeState }
  | { id: string; scope: "metadata"; field: "tags"; before: string[]; after: string[]; state: ProposalChangeState }
  | { id: string; scope: "metadata"; field: "rating"; before: number; after: number; state: ProposalChangeState }
  | { id: string; scope: "block"; index: number; blockType: Block["type"]; before: Block; after: Block; state: ProposalChangeState }
  | { id: string; scope: "blocks"; before: Block[]; after: Block[]; state: ProposalChangeState };

export type RecipeProposalStatus = "pending" | "partial" | "applied" | "expired";
export type RecipeProposal = {
  id: string;
  recipeId: number;
  baseVersion: number;
  applicationVersion: number;
  reason: string;
  connectionId?: string;
  connectionName?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  status: RecipeProposalStatus;
  changes: RecipeProposalChange[];
};

export type RecipeProposalMutationResult = { proposal: RecipeProposal; recipe: StoredRecipe };

export interface RecipeProposalCommands {
  "recipes.proposals.create": {
    input: { recipeId: number; expectedVersion: number; proposedRecipe: Recipe; reason: string };
    output: RecipeProposal;
  };
  "recipes.proposals.list": { input: { recipeId?: number }; output: RecipeProposal[] };
  "recipes.proposals.apply": {
    input: { proposalId: string; changeIds: string[]; expectedVersion: number };
    output: RecipeProposalMutationResult;
  };
  "recipes.proposals.undo": {
    input: { proposalId: string; changeIds: string[]; expectedVersion: number };
    output: RecipeProposalMutationResult;
  };
}

const positiveId = z.number().int().positive();
const changeId = z.string().min(1).max(200);
const state = z.enum(["pending", "applied", "undone"]);
const metadataChange = z.discriminatedUnion("field", [
  z.object({ id: changeId, scope: z.literal("metadata"), field: z.enum(["name", "source", "notes"]), before: z.string(), after: z.string(), state }).strict(),
  z.object({ id: changeId, scope: z.literal("metadata"), field: z.literal("tags"), before: z.array(z.string()), after: z.array(z.string()), state }).strict(),
  z.object({ id: changeId, scope: z.literal("metadata"), field: z.literal("rating"), before: z.number().int().min(0).max(2), after: z.number().int().min(0).max(2), state }).strict(),
]);
const proposalChange = z.discriminatedUnion("scope", [
  metadataChange,
  z.object({ id: changeId, scope: z.literal("block"), index: z.number().int().min(0), blockType: BlockTypeSchema, before: BlockSchema, after: BlockSchema, state }).strict(),
  z.object({ id: changeId, scope: z.literal("blocks"), before: z.array(BlockSchema), after: z.array(BlockSchema), state }).strict(),
]);

const proposal = z.object({
  id: changeId,
  recipeId: positiveId,
  baseVersion: positiveId,
  applicationVersion: positiveId,
  reason: z.string().min(1).max(4000),
  connectionId: z.string().min(1).max(200).optional(),
  connectionName: z.string().min(1).max(100).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  status: z.enum(["pending", "partial", "applied", "expired"]),
  changes: z.array(proposalChange).min(1).max(200),
}).strict();

const mutationInput = z.object({
  proposalId: changeId,
  changeIds: z.array(changeId).min(1).max(200).refine(ids => new Set(ids).size === ids.length),
  expectedVersion: positiveId,
}).strict();

export const recipeProposalCommandSchemas = {
  "recipes.proposals.create": z.object({ recipeId: positiveId, expectedVersion: positiveId, proposedRecipe: RecipeSchema, reason: z.string().trim().min(1).max(4000) }).strict(),
  "recipes.proposals.list": z.object({ recipeId: positiveId.optional() }).strict(),
  "recipes.proposals.apply": mutationInput,
  "recipes.proposals.undo": mutationInput,
} as const;

export const recipeProposalSchema = proposal;
export const proposalChangeSchema = proposalChange;
export type RecipeProposalEvent = { type: "proposal.changed"; recipeId: number; proposalId: string };
