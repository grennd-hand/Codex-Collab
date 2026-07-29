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
      sameWorkspaceIdentity(current, overview) &&
      current?.selectedThreadId === overview.selectedThreadId
        ? current.history
        : [],
  };
}

function sameWorkspaceIdentity(
  current: WorkspaceSummary | null,
  overview: WorkspaceOverview,
): boolean {
  if (!current) return false;
  if (current.hostGeneration || overview.hostGeneration) {
    return current.hostGeneration === overview.hostGeneration;
  }
  return (
    current.hostDeviceLabel === overview.hostDeviceLabel &&
    current.rootLabel === overview.rootLabel
  );
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
