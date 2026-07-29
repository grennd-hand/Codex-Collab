---
applyTo: "**/*.{ts,tsx,mts,mjs}"
---

Follow `docs/reference/CODE_ORGANIZATION.md`. Prefer named exports and explicit domain types. Keep pure
transformations separate from network, process, filesystem, and database effects. A React
component owns one visible interaction domain; a hook owns one lifecycle/state machine; a route
owns one resource family. Do not bypass the repository line budgets by minifying, combining
statements, renaming a monolith, or creating `helpers`, `utils`, or `part2` catch-all modules.
