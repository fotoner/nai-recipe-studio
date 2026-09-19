import { z } from "zod/v4";
import { Recipe } from "../../lib/schema";

/** JSON Schema published through the MCP resource, generated from the app schema. */
export function recipeJsonSchema() {
  return z.toJSONSchema(Recipe);
}
