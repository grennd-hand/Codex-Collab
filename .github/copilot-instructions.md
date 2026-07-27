# Codex Collab code-generation rules

Read `AGENTS.md` and `docs/CODE_ORGANIZATION.md` before editing. Repository security and
concurrency invariants are mandatory and take precedence over convenience.

- Put new code in the documented layer and feature directory; do not add product modules to a
  package root.
- Give every file one sentence responsibility. If that sentence needs "and", split the concerns.
- Keep React views under 300 lines, hooks/parsers under 400, services under 500, routes under 350,
  and entrypoints under 600. Treat 50-line functions as a review signal and 100 lines as a hard
  split point.
- Split by state owner, business capability, resource family, or I/O boundary. Never split a
  monolith into numbered parts or move unrelated functions into a generic helpers file.
- Keep HTTP parsing/authentication in routes, business rules in services, SQL in repositories, and
  schema evolution in migrations.
- Preserve optimistic file hashes, explicit absolute shared roots, owner approval boundaries, and
  separate worktrees for concurrent writers.
- Add or update focused tests beside the module. Before handoff run `npm run validate:architecture`,
  `npm run typecheck`, `npm test`, `npm run build`, and `npm run validate:plugin`.
