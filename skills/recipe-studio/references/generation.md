# Generation

Use this sequence:

1. Call `generation_prepare` with the requested recipe, count, and optional seed. Preparing never starts a job.
2. Inspect the returned `approved` flag, `findings`, `expiresAt`, account status, and `estimatedAnlas`. An unknown estimate is not zero cost.
3. Resolve validation errors. Compare the requested count and known finite cost with the user's authorization; do not ask again when the user already authorized that count and the estimate is within their cost limit.
4. If the response has `approved: true` for a new MCP plan, the server has checked the generation permission, validation, cost, and per-plan connection limits. Start it immediately with the same `planId` and a stable `requestId` when it remains within the user's authorized cost limit.
5. If the count or cost exceeds a connection limit, MCP cannot approve or override it. Ask the user to reduce the request or change the connection limit in app Settings. Stop if the connection is revoked, permission is missing, or the estimate is unknown or over the user's authorized limit.
6. If the server has not already marked the plan approved, have the user approve that exact plan in the Recipe Studio app before starting. Do not infer approval from a tool input or natural-language message, and do not ask again for a plan that is already approved.
7. Poll `generation_status` or use the job event until the job completes, fails, or is cancelled.

The app/server remains authoritative for approval, connection permissions, account state, cost freshness, expiry, and policy checks. A connection has separate image permission and per-plan image/Anlas limits. Recheck a changed cost before starting; on `COST_CHANGED`, `PLAN_EXPIRED`, `APPROVAL_REQUIRED`, or `PERMISSION_DENIED`, do not retry the same start blindly. Reprepare if required and stop if approval or user authorization is still missing.

If a request or response is lost, retry the same `requestId` and `planId`; do not invent a new request ID until the app reports that the original cannot be found. Use `generation_cancel` for a running job when the user asks to stop it.
