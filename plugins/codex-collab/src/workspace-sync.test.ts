import { describe, expect, it } from "vitest";
import {
  nextPendingCodexCommand,
  shouldPublishWorkspaceSnapshot,
  shouldReadWorkspaceHistory,
  workspaceHistoryDigest,
  type WorkspaceSyncMarker,
} from "./workspace-sync.js";

const marker: WorkspaceSyncMarker = {
  sessionId: "session-1",
  threadId: "thread-1",
  revision: "updated:1",
  historyDigest: "digest-1",
};

describe("workspace background sync", () => {
  it("reads and publishes when the selected task revision changes", () => {
    const state = {
      force: false,
      sessionId: "session-1",
      threadId: "thread-1",
      syncedAt: "2026-07-25T00:00:00.000Z",
      revision: "updated:2",
      marker,
    };

    expect(shouldReadWorkspaceHistory(state)).toBe(true);
    expect(shouldPublishWorkspaceSnapshot(state, "digest-2")).toBe(true);
  });

  it("skips an unchanged selected task", () => {
    const state = {
      force: false,
      sessionId: "session-1",
      threadId: "thread-1",
      syncedAt: "2026-07-25T00:00:00.000Z",
      revision: "updated:1",
      marker,
    };

    expect(shouldReadWorkspaceHistory(state)).toBe(false);
  });

  it("uses the history digest when no task revision is available", () => {
    const fallbackMarker = { ...marker, revision: null };
    const state = {
      force: false,
      sessionId: "session-1",
      threadId: "thread-1",
      syncedAt: "2026-07-25T00:00:00.000Z",
      revision: null,
      marker: fallbackMarker,
    };

    expect(shouldReadWorkspaceHistory(state)).toBe(true);
    expect(shouldPublishWorkspaceSnapshot(state, "digest-1")).toBe(false);
    expect(shouldPublishWorkspaceSnapshot(state, "digest-2")).toBe(true);
  });

  it("changes the digest when an imported record changes", () => {
    const original = workspaceHistoryDigest([
      {
        id: "message-1",
        role: "assistant",
        text: "First answer",
        createdAt: "2026-07-25T00:00:00.000Z",
      },
    ]);
    const updated = workspaceHistoryDigest([
      {
        id: "message-1",
        role: "assistant",
        text: "Updated answer",
        createdAt: "2026-07-25T00:00:00.000Z",
      },
    ]);

    expect(updated).not.toBe(original);
  });

  it("forwards pending Codex prompts from approved members in Relay order", () => {
    const pending = nextPendingCodexCommand(
      [
        {
          id: "chat-1",
          sessionId: "session-1",
          senderMemberId: "owner-1",
          senderDisplayName: "Owner",
          kind: "chat",
          body: "Discuss this first",
          attachments: [],
          codexOptions: null,
          deliveryStatus: null,
          codexTurnId: null,
          completedAt: null,
          createdAt: "2026-07-25T00:00:00.000Z",
        },
        {
          id: "prompt-2",
          sessionId: "session-1",
          senderMemberId: "editor-1",
          senderDisplayName: "Editor",
          kind: "codex_prompt",
          body: "Deploy after the checks",
          attachments: [],
          codexOptions: null,
          deliveryStatus: "queued",
          codexTurnId: null,
          completedAt: null,
          createdAt: "2026-07-25T00:00:02.000Z",
        },
        {
          id: "prompt-1",
          sessionId: "session-1",
          senderMemberId: "owner-1",
          senderDisplayName: "Owner",
          kind: "codex_prompt",
          body: "Run the checks",
          attachments: [],
          codexOptions: null,
          deliveryStatus: "queued",
          codexTurnId: null,
          completedAt: null,
          createdAt: "2026-07-25T00:00:03.000Z",
        },
      ],
      [],
    );

    expect(pending?.id).toBe("prompt-2");
    expect(pending?.senderMemberId).toBe("editor-1");
  });

  it("skips prompts that were already forwarded", () => {
    const pending = nextPendingCodexCommand(
      [
        {
          id: "prompt-1",
          sessionId: "session-1",
          senderMemberId: "owner-1",
          senderDisplayName: "Owner",
          kind: "codex_prompt",
          body: "First",
          attachments: [],
          codexOptions: null,
          deliveryStatus: "queued",
          codexTurnId: null,
          completedAt: null,
          createdAt: "2026-07-25T00:00:00.000Z",
        },
        {
          id: "prompt-2",
          sessionId: "session-1",
          senderMemberId: "editor-1",
          senderDisplayName: "Editor",
          kind: "codex_prompt",
          body: "Second",
          attachments: [],
          codexOptions: null,
          deliveryStatus: "queued",
          codexTurnId: null,
          completedAt: null,
          createdAt: "2026-07-25T00:00:01.000Z",
        },
      ],
      ["prompt-1"],
    );

    expect(pending?.id).toBe("prompt-2");
  });
});
