# Recipes

Recipes are ordered blocks. The app schema and defaults are published at `recipe-studio://schema/recipe`; use that resource instead of copying a stale schema into a prompt.

For an existing recipe, fetch it with `recipes_get` before editing. Send a complete valid recipe to `recipes_save` and include `expectedVersion` when updating a stored record. An optimistic version conflict means another actor changed the recipe; fetch the newest version, preserve its unrelated changes, and ask for a merge decision when the requested edit overlaps.

Use `recipe_validate` for findings and optional fix suggestions. It does not save the result. Use `recipe_compose` to inspect the prompt and negative prompt that the app would send; it does not call the image API. Use `recipes_duplicate` when the user wants a new variant while preserving the original.

Characters and presets are shared workspace records. Preserve age flags, locked records, block order, and fields not covered by the requested edit. Do not use an arbitrary file or database operation as a substitute for the tools.

When the user wants to review an AI change before saving, use `recipe_propose_changes` with the current recipe ID, `expectedVersion`, the complete proposed recipe, and a concise reason. The app calculates the changes against the saved version. Creating a proposal does not modify the recipe. Report the returned proposal and direct the user to the recipe editor's AI changes panel to select changes and apply them. Use `recipe_proposals_list` to check the outcome; do not claim it was applied merely because the proposal was accepted by the tool.

Proposal application and undo happen in the app. They create new recipe versions and preserve version conflict checks. Re-read the recipe after a conflict or an expired proposal before preparing a replacement. Existing authorized direct edits can still use `recipes_save`; do not require a proposal when the user asked for an immediate edit.

A cast member may contain `character_snapshot`, which freezes the character information used by an earlier image. Preserve it when editing unrelated blocks. If the user explicitly chooses a different registered character, replace its character reference and remove the old snapshot together.
