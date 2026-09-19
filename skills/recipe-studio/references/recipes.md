# Recipes

Recipes are ordered blocks. The app schema and defaults are published at `recipe-studio://schema/recipe`; use that resource instead of copying a stale schema into a prompt.

For an existing recipe, fetch it with `recipes_get` before editing. Send a complete valid recipe to `recipes_save` and include `expectedVersion` when updating a stored record. An optimistic version conflict means another actor changed the recipe; fetch the newest version, preserve its unrelated changes, and ask for a merge decision when the requested edit overlaps.

Use `recipe_validate` for findings and optional fix suggestions. It does not save the result. Use `recipe_compose` to inspect the prompt and negative prompt that the app would send; it does not call the image API. Use `recipes_duplicate` when the user wants a new variant while preserving the original.

Characters and presets are shared workspace records. Preserve age flags, locked records, block order, and fields not covered by the requested edit. Do not use an arbitrary file or database operation as a substitute for the tools.
