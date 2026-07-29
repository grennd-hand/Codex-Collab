import type { Member, Message, RealtimeEnvelope } from "@codex-collab/protocol";
import type { RuntimeNotificationV1 } from "../../../shared/runtime/index.js";

export function realtimeNotification(
  envelope: RealtimeEnvelope,
  currentMember: Member,
): RuntimeNotificationV1 | null {
  if (envelope.type === "message.created") {
    const message = envelope.payload as Message;
    return message.senderMemberId === currentMember.id
      ? null
      : {
          title: "Codex Collab 新消息",
          body: "协作房间收到一条新消息。",
        };
  }
  if (envelope.type === "member.updated") {
    const member = envelope.payload as Member;
    if (
      currentMember.role === "owner" &&
      member.id !== currentMember.id &&
      member.status === "pending"
    ) {
      return {
        title: "Codex Collab 待批准成员",
        body: "有新成员正在等待主人批准。",
      };
    }
  }
  return null;
}
