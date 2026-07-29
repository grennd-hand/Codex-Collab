# Code organization

This document defines the intended repository boundaries. The goal is not to create many tiny
files; it is to keep one state owner and one interaction domain per module.

## Repository layers

- `apps/dashboard`: browser UI. It may depend on `packages/protocol`, but not on Relay or plugin
  implementation files.
- `apps/desktop`: Electron owner application. Main owns credentials, Relay and Host access; the
  renderer consumes only the versioned preload bridge and reusable Dashboard feature contracts.
- `apps/relay`: authenticated transport and durable collaboration state. HTTP routing must delegate
  data rules to focused store/domain modules.
- `packages/protocol`: shared wire types, validation, and redaction rules. It must not import an app.
- `plugins/codex-collab`: local Host integration, Codex app-server adapter, file sandbox, and MCP.
  Browser-only types do not belong here.
- `native/host-ipc`: the focused Rust/Win32 security broker; conventional crate modules stay flat
  until a real protocol, transport, or platform subtree exists.
- `deploy`: production Compose and Caddy assets. Runtime data and credentials never belong here.
- `docs`: reference, operations, plans, and dated audit evidence.
- `scripts`: architecture, Desktop release, plugin validation, and probe tooling; never product
  business logic.

## Dashboard source layout

```text
src/
  App.tsx               Application composition and cross-feature coordination
  app/                  Dashboard controller, shell and orchestration-only state helpers
  features/
    activity/           Collaboration activity presentation
    collaboration/      Member identity, approvals, and peer collaboration
    composer/           Codex/peer input controls and attachment preparation
    dialogs/            Pairing, invitation and permission dialogs
    session/            Connection, invitation, recovery, realtime and submission lifecycles
    timeline/           content/, execution/, history/ and the timeline composition surface
    workspace/          Shared-workspace controllers plus history/state helpers
  ide/                  changes/, editor/, explorer/, shell/ and task/workspace state
  layout/               split-pane/ and persisted workspace panel geometry
  shared/               Low-level API, clipboard, time, and media utilities
  styles/               Global foundation/responsive rules; feature styles stay by their feature
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

## Desktop source layout

```text
apps/desktop/
  src/
    main.ts             Electron process entrypoint
    preload.cts         Enumerated renderer bridge entrypoint
    app/                application lifecycle and desktop configuration
    credentials/        safeStorage-backed owner session state
    host/               shared Host launch, lifecycle and resources
    ipc/                versioned contract and sender-validated handlers
    relay/              typed Relay transport and realtime control
    release/            packaging and renderer-entry policy specifications
    security/           BrowserWindow, protocol and shell policy
  renderer/
    index.html          Vite document entrypoint
    main.tsx            Desktop renderer composition entrypoint
    app/                Desktop view adapter
    shell/              command bar, rails and full-window workbench
    panes/              collaboration, file and Codex task panes
    styles/             Desktop-only workbench styles
```

Only the two Electron process entrypoints and two renderer entry files may stay at their respective
roots. The architecture validator rejects new unclassified files there. `main.ts` remains the stable
compiled `dist/main/main.js` target and `preload.cts` remains the stable `preload.cjs` target, so
packaging and security paths do not depend on internal folder movement.

## Plugin source layout

```text
src/
  mcp-server.ts                 MCP process entrypoint only
  workspace-sync-worker.ts     Host Worker process entrypoint only
  app-server/                  Codex app-server facade, transport, lifecycle and history parsing
  codex/                       Codex command delivery and Desktop IPC adapter
  host/                        Host application/runtime/service ownership
    ipc/                       authenticated Named Pipe protocol and transport
  mcp/                         declarative MCP tool catalog
  persistence/                 local profile, durable command outbox and recovery receipts
  relay/                       typed Relay HTTP clients and transport
  sync/                        workspace synchronization orchestration and admission
  workspace/                   roots, snapshots and file-operation execution
    sandbox/                   path policy, optimistic CAS and Windows native publication helpers
```

Only the two process entrypoints may remain as files directly under the plugin `src/` root; the
architecture validator rejects additional root files. Tests live beside their implementation. Do
not add a catch-all barrel: cross-domain imports stay explicit so security-sensitive dependencies
remain visible during review.

The intended dependency flow is entrypoints -> `mcp/host`; `host` composes `app-server`,
`persistence`, `relay`, `sync`, and `workspace`; `sync` coordinates `codex`, `persistence`, `relay`,
and `workspace`; `workspace/sandbox` stays below Host, Relay, Codex, and MCP orchestration. The
root-file rule is enforced now; finer import-direction gates should be added only after current
cross-domain contracts are measured and made acyclic.

## Conventional public module roots

`packages/protocol/src` intentionally keeps its six wire-contract modules and `index.ts` together.
They are a small public API surface, not an application feature tree. `native/host-ipc/src` likewise
keeps the focused Rust crate modules (`auth`, `frame`, `instance`, `pipe`, `protocol`, `security`,
`lib`, and `main`) at the crate root. Split either area only when a cohesive new subdomain appears;
do not add one-file directories merely to make the tree deeper.

## Repository support layout

```text
scripts/
  architecture/        source budgets, root allowlists and dependency gates
  desktop/             local Desktop E2E and packaged-artifact verification
  plugin/              portable plugin validation wrapper
  probes/              real MCP, app-server and workspace-flow probes
docs/
  README.md             documentation index
  reference/            current project and architecture facts
  operations/           deployment and testing runbooks
  plans/                roadmap and implementation plans
  audits/               dated evidence snapshots
```

Repository root files are limited to workspace manifests, tool configuration, ignore policies and
primary documentation. The enforced tracked-root allowlist is `.codex-collabignore`,
`.dockerignore`, `.gitignore`, `AGENTS.md`, `docker-compose.yml`, `package.json`,
`package-lock.json`, `README.md`, `skills-lock.json`, and `tsconfig.base.json`; additions require an
intentional architecture update. Deployment assets remain under `deploy/`; `.github/` and
`.agents/` retain their ecosystem-defined layouts. Runtime state belongs under ignored
runtime/user-data locations, never under source, docs, packaging inputs or deployment configuration.

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
  server.ts             Stable process bootstrap and router composition entrypoint
  application/          Public SessionStore composition facade
  accounts/             Passkey/account authentication and persistence
  collaboration/        Sessions, members, invites and messages
  http/                 Typed HTTP payload and invite/Codex option adapters
  realtime/             One-time realtime ticket lifecycle
  routes/               HTTP parsing, authorization entry points, response mapping
  security/             Bearer token issue/hash primitives
  storage/              SQLite schema, migrations, row mapping and transactions
  testing/              Shared store fixtures used across domain specifications
  workspace/            Catalog, history pagination, files, operations
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

See [ARCHITECTURE_AUDIT_2026-07-28.md](../audits/ARCHITECTURE_AUDIT_2026-07-28.md) for evidence, priority and
acceptance criteria.
