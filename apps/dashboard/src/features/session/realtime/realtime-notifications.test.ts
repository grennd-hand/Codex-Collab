import { describe, expect, it } from "vitest";
import type { Member, Message, RealtimeEnvelope } from "@codex-collab/protocol";
import { realtimeNotification } from "./realtime-notifications.js";

const owner: Member = {
  id: "owner-1",
  sessionId: "session-1",
  displayName: "Owner",
  deviceLabel: "Desktop",
  role: "owner",
  status: "approved",
  workspaceFileAccess: "workspace-write",
  createdAt: "2026-07-28T00:00:00.000Z",
  approvedAt: "2026-07-28T00:00:00.000Z",
};

function envelope(type: RealtimeEnvelope["type"], payload: unknown): RealtimeEnvelope {
  return { type, sessionId: owner.sessionId, payload } as RealtimeEnvelope;
}

describe("realtime desktop notifications", () => {
  it("reports an incoming message without exposing its text or sender name", () => {
    const message = {
      id: "message-1",
      sessionId: owner.sessionId,
      senderMemberId: "member-2",
      senderDisplayName: "Private Name",
      kind: "chat",
      body: "sensitive message body",
      attachments: [],
      codexOptions: null,
      deliveryStatus: null,
      codexTurnId: null,
      workspaceThreadId: null,
      completedAt: null,
      createdAt: owner.createdAt,
    } satisfies Message;
    const notification = realtimeNotification(
      envelope("message.created", message),
      owner,
    );

    expect(notification).toEqual({
      title: "Codex Collab 新消息",
      body: "协作房间收到一条新消息。",
    });
    expect(JSON.stringify(notification)).not.toContain("sensitive message body");
    expect(JSON.stringify(notification)).not.toContain("Private Name");
  });

  it("reports only another pending member to the owner", () => {
    const pending = {
      ...owner,
      id: "member-2",
      role: "editor",
      status: "pending",
      displayName: "Private Name",
    } satisfies Member;
    expect(
      realtimeNotification(envelope("member.updated", pending), owner),
    ).toEqual({
      title: "Codex Collab 待批准成员",
      body: "有新成员正在等待主人批准。",
    });
    expect(
      realtimeNotification(envelope("member.updated", pending), {
        ...owner,
        role: "editor",
      }),
    ).toBeNull();
  });

  it("does not notify for the current member's own message", () => {
    expect(
      realtimeNotification(
        envelope("message.created", { senderMemberId: owner.id }),
        owner,
      ),
    ).toBeNull();
  });
});
