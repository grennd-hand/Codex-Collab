import type { WorkspaceSyncState } from "@codex-collab/protocol";
import type {
  CodexAppServerClient,
  CodexThreadSummary,
} from "./app-server-client.js";
import type { LocalProfile } from "./local-profile.js";
import type { RelayClient } from "./relay-client.js";

export async function cacheNextWorkspaceThreadHistory(
  profile: LocalProfile,
  workspace: WorkspaceSyncState,
  localThreads: readonly CodexThreadSummary[],
  codex: Pick<CodexAppServerClient, "readThreadHistory">,
  relay: Pick<RelayClient, "publishWorkspaceHistory">,
): Promise<WorkspaceSyncState> {
  if (!workspace.cachedThreadIds) return workspace;
  const cached = new Set(workspace.cachedThreadIds);
  const next = localThreads.find(
    (thread) =>
      thread.id !== workspace.selectedThreadId && !cached.has(thread.id),
  );
  if (!next) return workspace;

  const history = await codex.readThreadHistory(next.id, next.path);
  return relay.publishWorkspaceHistory(
    profile.sessionId,
    profile.memberToken,
    { threadId: next.id, history },
  );
}
