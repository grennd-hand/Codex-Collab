import type { WorkspaceSyncState } from "@codex-collab/protocol";
import type {
  CodexAppServerClient,
  CodexThreadSummary,
} from "../app-server/app-server-client.js";
import type { LocalProfile } from "../persistence/local-profile.js";
import type { RelayClient } from "../relay/relay-client.js";
import { limitRecordEntries } from "../app-server/history-common.js";

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

  const history = limitRecordEntries(
    await codex.readThreadHistory(next.id, next.path),
  );
  return relay.publishWorkspaceHistory(
    profile.sessionId,
    profile.memberToken,
    { threadId: next.id, history },
  );
}
