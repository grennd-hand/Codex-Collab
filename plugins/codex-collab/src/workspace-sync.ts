import { createHash } from "node:crypto";
import type { CodexRecordEntry, Message } from "@codex-collab/protocol";

export interface WorkspaceSyncMarker {
  sessionId: string;
  threadId: string;
  revision: string | null;
  historyDigest: string;
}

interface WorkspaceSyncState {
  force: boolean;
  sessionId: string;
  threadId: string;
  syncedAt: string | null;
  revision: string | null;
  marker: WorkspaceSyncMarker | null;
}

function markerMatches(
  state: WorkspaceSyncState,
  marker: WorkspaceSyncMarker | null,
): marker is WorkspaceSyncMarker {
  return (
    marker?.sessionId === state.sessionId &&
    marker.threadId === state.threadId
  );
}

export function shouldReadWorkspaceHistory(state: WorkspaceSyncState): boolean {
  if (state.force || !state.syncedAt || !markerMatches(state, state.marker)) {
    return true;
  }
  if (state.revision === null) {
    return true;
  }
  return state.marker.revision !== state.revision;
}

export function shouldPublishWorkspaceSnapshot(
  state: WorkspaceSyncState,
  historyDigest: string,
): boolean {
  if (state.force || !state.syncedAt || !markerMatches(state, state.marker)) {
    return true;
  }
  if (state.revision !== null) {
    return state.marker.revision !== state.revision;
  }
  return state.marker.historyDigest !== historyDigest;
}

export function workspaceHistoryDigest(history: CodexRecordEntry[]): string {
  const hash = createHash("sha256");
  for (const entry of history) {
    hash.update(entry.id);
    hash.update("\0");
    hash.update(entry.role);
    hash.update("\0");
    hash.update(entry.phase ?? "");
    hash.update("\0");
    hash.update(entry.createdAt ?? "");
    hash.update("\0");
    hash.update(entry.text);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function nextPendingCodexCommand(
  messages: Message[],
  forwardedMessageIds: readonly string[],
): Message | null {
  const forwarded = new Set(forwardedMessageIds);
  return (
    messages.find(
      (message) =>
        (message.kind === "codex_prompt" || message.kind === "codex_stop") &&
        message.deliveryStatus === "queued" &&
        !forwarded.has(message.id),
    ) ?? null
  );
}
