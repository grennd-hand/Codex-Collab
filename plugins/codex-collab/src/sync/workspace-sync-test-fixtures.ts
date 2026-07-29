import type { WorkspaceSummary, WorkspaceSyncState } from "@codex-collab/protocol";
import type { LocalProfile } from "../persistence/local-profile.js";

export const profile: LocalProfile = {
  relayUrl: "https://relay.example.com",
  sessionId: "session-1",
  memberId: "owner-1",
  displayName: "Owner",
  role: "owner",
  memberToken: "member-token",
  projectRoot: "C:\\project",
  forwardedMessageIds: [],
  observedThreadIds: ["thread-1"],
  threadCatalogVersion: 1,
};

export const ownerPrompt = {
  id: "prompt-1",
  sessionId: "session-1",
  senderMemberId: "owner-1",
  senderDisplayName: "Owner",
  kind: "codex_prompt" as const,
  body: "Run the checks",
  attachments: [],
  codexOptions: null,
  deliveryStatus: "queued" as const,
  codexTurnId: null,
  workspaceThreadId: "thread-1",
  completedAt: null,
  createdAt: "2026-07-25T00:00:00.000Z",
};

export function syncState(workspace: WorkspaceSummary): WorkspaceSyncState {
  const { history, files, ...state } = workspace;
  return {
    ...state,
    historyCount: history.length,
    fileCount: files.length,
  };
}
