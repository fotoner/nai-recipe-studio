# NAI Recipe Studio development

Use Korean for collaboration and English for code and prompt tags. This is the independently distributed Electron app. Do not import source, data, recipes, output, credentials, or private documentation from the parent repository.

- Preserve existing user work. Never commit secrets, generated images, databases, caches, or personal style presets.
- New features and fixes use a failing behavioral test before implementation. Refactoring first protects behavior with regression tests; do not call those TDD retroactively.
- Use synthetic fixtures, temporary databases, and injected network responses. Never use real generation/subscription APIs, credentials, the user's DB, or output files in tests.
- Run `pnpm check` and `pnpm build`; report platform/package checks that cannot run.
- UI, IPC, and MCP share services and contracts. Core logic has no platform or filesystem dependency.
- All product UI strings are localized in Korean, Japanese, and English. User data and prompt tags are never translated by UI language selection.
- Do not include scenario/trend features or the parent repository's personal context. Keep a small generic palette.
- User has authorized parallel subagents using gpt-5.6-luna with max reasoning. Root coordinates shared contracts and integration.
