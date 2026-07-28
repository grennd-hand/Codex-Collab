# Code organization

This document defines the intended repository boundaries. The goal is not to create many tiny
files; it is to keep one state owner and one interaction domain per module.

## Repository layers

- `apps/dashboard`: browser UI. It may depend on `packages/protocol`, but not on Relay or plugin
  implementation files.
- `apps/relay`: authenticated transport and durable collaboration state. HTTP routing must delegate
  data rules to focused store/domain modules.
- `packages/protocol`: shared wire types, validation, and redaction rules. It must not import an app.
- `plugins/codex-collab`: local Host integration, Codex app-server adapter, file sandbox, and MCP.
  Browser-only types do not belong here.
- `scripts`: end-to-end probes and repository validation, not product business logic.

## Dashboard source layout

```text
src/
  App.tsx               Application composition and cross-feature coordination
  app/                  App shell and orchestration-only state helpers
  features/
    activity/           Collaboration activity presentation
    collaboration/      Member identity, approvals, and peer collaboration
    composer/           Codex/peer input controls and attachment preparation
    dialogs/            Pairing, invitation and permission dialogs
    session/            Session setup, invitation, and credential lifecycle
    timeline/           Imported history, execution steps, and scroll restoration
    workspace/          Shared-workspace permissions and state
  ide/                  Explorer, Monaco models, tabs, saves, and conflicts
  layout/               Split panes and persisted panel geometry
  shared/               Low-level API, clipboard, time, and media utilities
  styles/               Ordered feature styles; `styles.css` is import-only
```

The intended import direction is:

```text
shared -> protocol/external libraries
features -> shared + protocol
ide/layout -> shared + protocol
app shell -> features + shared + protocol
App -> all browser layers
```

`shared/` must never import `features/`, `app/`, `ide/`, or `layout/`. Tests live beside the module
they verify. Avoid barrel exports across large features because they hide dependency direction and
increase accidental bundle coupling.

The current checkout does not fully satisfy the broader graph: workspace controllers import
app/composer/timeline modules, and timeline presentation imports IDE types/components. The existing
architecture validator enforces only the `shared/` upward-import prohibition, so a passing check is
not proof that every feature boundary is clean. Move cross-feature contracts and pure adapters to a
lower shared/domain layer, then extend the validator before declaring this debt complete.

## File sizing and split rules

There is no universal perfect line count. ESLint documents a common recommendation range of
100-500 lines, defaults `max-lines` to 300, and defaults `max-lines-per-function` to 50. This
repository therefore uses 300 lines as the normal file budget and applies a higher limit only when
the module type justifies it.

| Module kind | Normal target | Hard limit | Split axis |
| --- | ---: | ---: | --- |
| React view/component | 150-250 | 300 | one interaction domain |
| Hook/controller/reducer | 200-300 | 400 | one state owner/lifecycle |
| Parser/adapter/serializer | 150-300 | 400 | one input/output contract |
| Domain service/repository | 200-400 | 500 | one business capability |
| HTTP route module | 150-300 | 350 | one resource family |
| Feature stylesheet | 200-350 | 500 | one visual/interaction domain |
| App/process entrypoint | 100-300 | 600 | bootstrap and composition only |
| Unit/component test | 200-500 | 700 | one coherent specification |

Functions are reviewed at 50 physical lines and normally fail at 100. JSX is not exempt. A file is
split before the numeric limit when it has more than one reason to change, mixes I/O with pure
transformation, owns unrelated state machines, or requires unrelated fixtures.

### How to split

1. Name the file's one sentence responsibility. If the sentence contains "and", identify separate
   modules.
2. Keep the state owner with its reducer/effects. Extract pure view components, parsers, and clients;
   do not let multiple files secretly mutate the same state.
3. Keep I/O at boundaries. HTTP routes parse/authenticate/map responses; services enforce business
   rules; repositories own SQL; migrations only evolve schema.
4. Organize React by visible interaction domain and data hierarchy. Keep controlled values in the
   nearest common owner and derive duplicate state instead of storing it twice.
5. Organize Relay routes by resource (`account`, `session`, `message`, `workspace`), not by HTTP verb.
6. Organize persistence by business domain. Cross-domain transactions live in a named coordinator,
   and receive an explicit database/transaction context.
7. Organize plugin app-server code into transport, history parsing, and process lifecycle. The public
   client is a facade that composes those modules and contains no protocol parser implementation.
8. Mirror production boundaries in tests. Shared fixtures move to a named test-support module only
   after three consumers need them.

### Anti-evasion rules

- Do not create catch-all `helpers.ts`, `utils.ts`, `common.ts`, `part2.ts`, or a renamed monolith.
- A facade may delegate but may not contain another copy of the business logic.
- `types.ts` is allowed only for types shared by multiple sibling modules; otherwise colocate types
  with their owner.
- Generated, vendored, migration, and declarative protocol-table exceptions require an explicit
  architecture allowlist with a reason and owner.
- Growth ceilings only move downward. A change that touches an oversized legacy file must leave it
  smaller or extract a cohesive responsibility.

`npm run validate:architecture` enforces current file-growth ceilings and selected import/style
rules. A guarded file must be reduced or have a cohesive module extracted before it can grow. The
ceilings are intentionally transitional and should only move downward. The current classifier does
not recognize every `use*Controller.ts` outside a `hooks/` or `controllers/` directory and does not
enforce the 100-line function limit; those guard gaps are tracked work, not permission to ignore the
documented limits.

## Current Relay structure

The Relay currently uses:

```text
src/
  server.ts             Process bootstrap and router composition
  routes/               HTTP parsing, authorization entry points, response mapping
  accounts/             Passkey/account persistence
  collaboration/        Sessions, members, invites, messages
  workspace/            Catalog, history pagination, files, operations
  storage/              SQLite schema, migrations, row mapping, transactions
```

These extractions are already implemented. `SessionStore` is now a small public facade, but the
implementation is connected through a 14-level inheritance chain from `SqliteSessionStore` through
account, collaboration, workspace and operation stores. The file split is therefore real while the
dependency direction remains implicit.

## Remaining decomposition targets

1. Define separate `WorkspaceDataKey` and `TaskUiKey`; move Codex draft/attachments, open tabs,
   dirty drafts, Monaco models and task-specific panel state under the task owner.
2. Replace `DashboardViewModel`'s hook `ReturnType` coupling with explicit feature slice contracts;
   move cross-feature adapters down and enforce the real dependency graph.
3. Keep the `SessionStore` facade, but migrate its internal inheritance chain toward composition
   around one explicit `DbContext`/transaction runner and domain repositories. Start with workspace
   operations; do not perform a big-bang rewrite.
4. Give Codex commands a Relay-owned claim/lease/idempotency contract instead of deriving a command
   queue from the latest 500 chat messages and a local forwarded-ID array.
5. Split `App`, `server`, workspace history controller and plugin orchestrators only at a state,
   protocol, I/O or transaction boundary. Add AST/import-cycle/React Hooks checks before tightening
   their growth ceilings.

Each extraction must preserve behavior, keep security checks at the boundary, add focused tests, and
pass the repository gates before merge or deployment.

See [ARCHITECTURE_AUDIT_2026-07-28.md](./ARCHITECTURE_AUDIT_2026-07-28.md) for evidence, priority and
acceptance criteria.
