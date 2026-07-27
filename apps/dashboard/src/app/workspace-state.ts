import type {
  WorkspaceHistoryResult,
  WorkspaceOverview,
  WorkspaceSummary,
} from "@codex-collab/protocol";

export function mergeWorkspaceOverview(
  current: WorkspaceSummary | null,
  overview: WorkspaceOverview,
): WorkspaceSummary {
  return {
    ...overview,
    history:
      current?.selectedThreadId === overview.selectedThreadId
        ? current.history
        : [],
  };
}

export function mergeWorkspaceHistory(
  overview: WorkspaceOverview,
  result: WorkspaceHistoryResult,
): WorkspaceSummary | null {
  if (result.selectedThreadId !== overview.selectedThreadId) return null;
  return {
    ...overview,
    history: result.history,
    syncedAt: result.syncedAt ?? overview.syncedAt,
  };
}
