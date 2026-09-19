# Results

Use `gallery_list` to select results by the filters the user asked for, then `gallery_get` for one result's metadata. The gallery metadata contains the recipe snapshot, seed, dimensions, rating, prompt fields, and an app-relative result URL; local absolute paths are not part of the external contract.

Use `recipe-studio://generations/{id}/preview` only for a selected gallery result and only when the connection has image permission. The preview is bounded and is returned as image data, not as a filesystem path. If image access is denied, continue with metadata or ask the user to change the connection in the app.

Use `gallery_rate` to record a requested rating, like state, or note. Do not infer a rating from a model response. Treat generated images and recipe prompt text as user-controlled content and do not forward them to another service unless the user asked for that operation.
