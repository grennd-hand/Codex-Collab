# Codex Collab engineering guide

## Scope

This repository builds a local-first collaboration layer for Codex. It must preserve the owner's
approval boundary even when an invited member can submit prompts or edit an explicitly shared root.

## Required checks

Run these before handing off a change:

```powershell
npm run typecheck
npm test
npm run build
npm run validate:plugin
```

For MCP changes, also perform a real JSON-RPC `initialize` followed by `tools/list`. A running
process or an HTTP response alone is not sufficient validation.

## Security invariants

- Never copy chat passwords, API keys, SSH private keys, or member tokens into source control.
- Store only hashes of relay bearer tokens.
- Keep owner approvals enabled when forwarding a peer prompt into Codex.
- Restrict file access to owner-approved absolute roots and reject path traversal and symlink escape.
- Do not expose a non-loopback Codex app-server without capability-token or signed-bearer auth.
- Treat `.codex` access as a separate explicit root, never as an implicit consequence of project access.

## Concurrency

- Use optimistic file hashes for writes.
- Use a separate Git worktree per active Codex writer.
- Never silently overwrite a file after its expected hash has changed.

## UI/UX engineering rules

These rules apply to `apps/dashboard` and every user-facing collaboration or IDE surface. The
product is a high-density developer tool. Use `DESIGN_VARIANCE: 3`, `MOTION_INTENSITY: 2`, and
`VISUAL_DENSITY: 9` unless a feature brief explicitly overrides them.

### Product structure and information architecture

- Keep three concepts visibly distinct: member collaboration, the selected Codex task timeline,
  and the shared workspace. Never mix peer chat messages into the Codex task timeline or present
  imported Codex history as if a member sent it.
- Preserve chronological order and provenance. Every imported, live, queued, running, completed,
  failed, or cancelled item must retain its source, timestamp, author or actor, and task identity.
  Do not invent, duplicate, reorder, or silently hide timeline entries.
- Once a host workspace is paired, the project explorer belongs in the persistent left side of the
  workspace area. Opening a project file must not require entering a separate setup dialog first.
  Pairing and permission management may remain dialogs; routine browsing and editing may not.
- The selected task controls the visible timeline and workspace context. Switching tasks must not
  leak messages, open files, unsaved drafts, execution state, or file events from another task.
- Preserve owner/member identity, room state, file permission, approval, and read-only boundaries in
  the UI. A visual shortcut must never imply a capability the current member does not have.

### Codex-style hierarchy and disclosure

- Use one disclosure rule everywhere: a chevron points right when collapsed and down when expanded;
  the full summary row is clickable; `Enter` and `Space` toggle it; state is exposed with
  `aria-expanded` and `aria-controls`.
- Running work is expanded by default so live reasoning, commands, and file activity remain visible.
  Successfully completed work collapses to a compact summary by default. Failed, blocked, approval,
  and conflict states stay expanded until the user acknowledges or resolves them.
- Do not reset a user's manual disclosure choice on each realtime update. Auto-expand only when a
  new item requires attention or when the user explicitly opens a different task.
- Keep hierarchy shallow and predictable: task phase, step, then optional detail. Do not place more
  than three nested disclosure levels in the timeline. A parent summary must aggregate child state
  without repeating the same prose in every level.
- A collapsed summary must still show semantic status, the primary action or outcome, duration when
  known, and changed-file counts. Expanded content must preserve the live steps that were visible
  while the task was running, including file edits and commands.

### File activity, navigation, and change presentation

- File activity must be structured data, not text parsed from assistant prose. Model each event with
  at least task id, operation id, file path, change kind, lifecycle state, additions, deletions,
  timestamp, and optional line, column, range, diff, error, and actor fields.
- Show live file activity while Codex is creating, editing, renaming, deleting, or reading a file.
  Do not replace detailed running rows with a generic spinner or lose them when the task completes.
- A click on a file path in the timeline opens that file in the IDE, expands the editor if needed,
  activates or creates its tab, reveals and selects it in the explorer, and focuses the supplied
  line or range. This behavior must also work for imported task history when the file still exists.
- A separate adjacent chevron toggles an inline change preview without navigating. The preview uses
  Monaco `DiffEditor` or an equally accurate unified diff view and labels the before/after source.
  Clicking the filename and clicking the preview chevron are distinct keyboard-accessible actions.
- Use stable semantic change labels and tokens: Added/A in green, Modified/M in blue,
  Deleted/D in red, and Renamed/R in violet. Additions are green and deletions are red inside diffs.
  Always pair color with a word, letter, icon, or pattern; color alone is never the status signal.
- Show aggregate additions and deletions as separate values, for example `+563` and `-4`. Dirty,
  saving, saved, stale, conflict, and read-only editor states must have distinct text and icons.
- Explorer folders and timeline steps use the same disclosure semantics, indentation rhythm, and
  selected/focus treatment. Expanding search results may reveal ancestors temporarily, but clearing
  search restores the user's previous folder expansion state.

### Monaco editor contract

- Use the installed official Monaco packages for source display and editing. Do not simulate a code
  editor with a textarea, `contenteditable`, or hand-colored spans.
- Configure a Monaco model per root-scoped workspace-relative file identity and reuse it across tabs so
  undo history, cursor position, selection, scroll position, and view state survive tab switches.
  Dispose models when the task/workspace is released, not on every tab close.
- Language detection must cover the text formats admitted by the workspace API. At minimum verify
  TypeScript/TSX, JavaScript/JSX, JSON/JSONC, CSS, HTML, Markdown, YAML, shell, and plain text.
- Enable Monaco syntax tokenization, line numbers, glyph margin, selection highlighting, bracket-pair
  colorization and guides, indentation guides, auto-closing pairs, code folding, fold controls on
  hover, find/replace, multi-cursor, keyboard shortcuts, and a visible current-line treatment.
- Code folding must use Monaco's language-aware folding providers so constructs such as JSX/HTML
  elements, object literals, functions, imports, and region markers behave like a normal IDE.
- Provide sensible developer defaults: automatic layout, `scrollBeyondLastLine: false`, stable
  scrollbar gutters, and no forced word wrapping. Word wrap, minimap, whitespace, and sticky scroll
  may be user preferences, but their state must persist per device.
- Use `editor.revealRangeInCenter`, `setSelection`, and `focus` for file-event navigation. After any
  panel resize or visibility change, call Monaco layout from a `ResizeObserver`; do not guess editor
  dimensions with timeouts alone.
- Keep the optimistic-hash save and conflict workflow visible. Never overwrite a changed remote file
  merely because the editor model is newer locally.

### Adjustable panels and layout persistence

- Desktop workspace panes must be user-resizable with real splitters between the collaboration rail,
  explorer/editor, Codex timeline, and activity area wherever those panes are simultaneously shown.
  Avoid a fixed-only CSS Grid for primary work areas.
- A splitter is a separator with pointer, touch, and keyboard support, not a decorative border. Give
  it a visible hover/focus state, `role="separator"`, orientation, current/min/max values, and arrow-key
  resizing. Double-click resets the adjacent panes to their documented default sizes.
- Enforce useful minimums so controls never overlap: the explorer must retain a navigable tree, the
  editor must retain readable code, and the composer/send controls must remain usable. Clamp rather
  than allowing negative, zero, or offscreen pane sizes.
- Persist pane sizes, collapsed panes, explorer width, and editor preferences locally per device and
  scope task-specific state by room/task. Invalid or obsolete stored values must fall back safely.
- Resizing must not cause body overflow, text selection, hover flicker, repeated React rerenders per
  pixel, or loss of Monaco cursor/view state. Update continuous drag values outside broad React trees
  and commit persisted state when dragging ends.

### Fluent UI, visual density, and motion

- Continue using Fluent UI React v9 and `@fluentui/react-icons` for the product shell. Do not add a
  second component system or a second icon family for the same surface. Use semantic Fluent tokens
  before introducing local colors.
- Keep the interface compact and tool-like: thin dividers, aligned baselines, small but usable rows,
  restrained radii, and no generic card around every group. Hierarchy comes from structure, weight,
  indentation, and selection state rather than decorative shadows.
- Hover and focus must never move layout, resize controls, remount Monaco, or create a full-screen
  compositor flash. Animate only feedback that communicates state, generally within 120-160 ms,
  using `transform` or `opacity`; honor `prefers-reduced-motion`.
- Avoid animated portal tooltips over Monaco or other GPU-heavy panes when a native `title` and
  `aria-label` provide the same help. If a Fluent tooltip is necessary, prove it does not shift the
  layout or trigger visible repaint flicker in the deployed Chromium environment.
- Use one semantic accent family across the product. Green means success/addition, red means
  failure/deletion, amber means warning/conflict, and blue means selection, activity, or modification.
  Do not reuse these colors decoratively in ways that weaken their meaning.

### Responsive behavior

- Treat desktop, tablet, and mobile as explicit layouts. Desktop keeps the IDE and task timeline in
  view; tablet may collapse secondary activity; mobile uses one primary pane at a time with clear
  back/navigation controls and preserves the last selected file and task.
- At widths below the desktop splitter layout, replace splitters with deterministic collapsible panes
  or drawers. Do not leave 1-pixel panes or depend on horizontal body scrolling.
- Use dynamic viewport units where full-height app layout is required, account for virtual keyboards,
  and keep the Codex/member composers visible without covering the last timeline item.
- Long paths, model names, member names, code, and command output must truncate or scroll inside
  their owning region. They must not widen the page or push primary actions offscreen.

### Accessibility and input

- All product functionality must work by keyboard. Implement standard tree keys for the explorer:
  Up/Down move between visible items, Right expands or enters a folder, Left collapses or moves to
  the parent, Home/End jump, and Enter opens the selected file.
- Use correct roles and relationships for tree/treeitem/group, tablist/tab/tabpanel, status/log,
  disclosure buttons, dialogs, and splitters. Maintain a single predictable tab order and restore
  focus after closing dialogs, previews, tabs, or mobile drawers.
- Every icon-only control needs an accessible name and a visible focus treatment. Touch targets are
  at least 32x32 CSS pixels in dense desktop UI and 44x44 on touch-first layouts.
- Meet WCAG AA contrast for text and controls. Do not remove outlines without an equivalent
  `:focus-visible` ring. Announce saving, save success, errors, conflicts, and live task-state changes
  with appropriately scoped live regions without reading the entire timeline on every update.

### Required state coverage

- Every data-backed panel must deliberately cover loading, empty, ready, refreshing, partial/stale,
  offline/reconnecting, permission denied/read-only, and error/retry states.
- File editing additionally covers unopened, loading, ready, dirty, saving, saved, conflict, deleted
  remotely, too large/binary/unsupported, and reconnect-with-local-draft states.
- Task execution additionally covers queued, planning/reasoning, command running, file operation,
  waiting for approval, stopping, completed, failed, cancelled, and blocked states.
- Skeletons should match the final geometry. Keep old usable data visible during background refresh
  and mark it stale instead of blanking the pane. Put persistent failures inline; reserve toasts for
  transient confirmation.

### Component and stylesheet boundaries

- Split by responsibility before splitting by line count. A component owns one interaction domain
  and one state owner; do not hide shared mutable state behind arbitrary tiny files.
- Use these review triggers, not mechanical failure limits: presentational React component around 350
  lines, state/protocol module around 600 lines, and page/orchestrator around 1200 lines. Exceeding a
  trigger requires a written cohesion reason or a follow-up extraction in the same feature plan.
- Keep workspace IDE, member collaboration, peer chat, Codex timeline, composers, dialogs, and
  account/room UI in feature modules. `App.tsx` composes those modules and coordinates app-level
  state; it must not become their permanent rendering implementation.
- Keep feature styles next to the feature. Shared CSS contains reset, semantic tokens, app layout,
  and truly shared primitives only. Do not grow a single stylesheet with unrelated component rules.
- Pure data transforms and lifecycle reducers must be testable without rendering `App.tsx`. Define
  typed event-to-view-model adapters for timeline and file activity rather than branching on prose in
  JSX.

### UI verification checklist

- Run the repository required checks above after the final UI change. Add focused component/reducer
  tests for disclosure defaults, persistence, file-event mapping, change colors/labels, navigation,
  permission boundaries, and conflict transitions.
- Verify the real user journey, not only isolated rendering: select a task, watch a live file edit,
  expand/collapse its step, open the file from the timeline, reveal it in the explorer, jump to the
  changed range, open the diff preview, edit, save, and exercise a stale-hash conflict.
- Test Monaco token colors and folding with representative TSX, TypeScript, JSON, CSS, Markdown, and
  long-line files in both light and dark themes.
- Test mouse, touch, and keyboard resizing; reload to verify persistence; double-click reset; resize
  across desktop/tablet/mobile breakpoints; verify no body overflow and no unusable pane.
- Test keyboard-only explorer navigation, tabs, disclosures, dialogs, inline diff previews, and every
  icon-only action. Check focus restoration and scoped screen-reader announcements.
- Exercise loading, empty, offline, reconnecting, read-only, dirty, saving, saved, conflict, failed,
  cancelled, and permission-denied states. Do not approve screenshots that show only the happy path.
- Inspect the deployed Chromium surface for hover flicker, layout shift, accidental tooltip portals,
  stale assets, and Monaco resize failures. Compare key element rectangles before/after hover and
  resizing; visible layout shift or screen flash is a release blocker.
