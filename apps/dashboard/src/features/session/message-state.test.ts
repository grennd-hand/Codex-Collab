import { describe, expect, it } from "vitest";
import type { Message } from "@codex-collab/protocol";
import { mergeConversationMessages } from "./message-state.js";

function message(
  id: string,
  deliveryStatus: Message["deliveryStatus"],
): Message {
  return {
    id,
    sessionId: "session-1",
    senderMemberId: "member-1",
    senderDisplayName: "Member",
    kind: "codex_prompt",
    body: id,
    attachments: [],
    codexOptions: null,
    deliveryStatus,
    codexTurnId: deliveryStatus === "queued" ? null : "turn-1",
    workspaceThreadId: "thread-1",
    completedAt:
      deliveryStatus === "completed" || deliveryStatus === "failed"
        ? "2026-07-30T00:01:00.000Z"
        : null,
    createdAt: "2026-07-30T00:00:00.000Z",
  };
}

describe("mergeConversationMessages", () => {
  it("does not let a stale refresh regress a completed realtime message", () => {
    const completed = message("prompt-1", "completed");
    const stale = message("prompt-1", "submitted");

    expect(mergeConversationMessages([completed], [stale])).toEqual([completed]);
  });

  it("accepts a terminal realtime update and retains messages missing from a stale snapshot", () => {
    const submitted = message("prompt-1", "submitted");
    const completed = message("prompt-1", "completed");
    const realtimeOnly = message("prompt-2", "queued");

    expect(
      mergeConversationMessages([submitted, realtimeOnly], [completed]),
    ).toEqual([completed, realtimeOnly]);
  });

  it("keeps chronological order when an existing message is updated", () => {
    const first = message("prompt-1", "submitted");
    const second = {
      ...message("prompt-2", "queued"),
      createdAt: "2026-07-30T00:02:00.000Z",
    };

    expect(
      mergeConversationMessages([first, second], [message("prompt-1", "completed")])
        .map((item) => item.id),
    ).toEqual(["prompt-1", "prompt-2"]);
  });
});
