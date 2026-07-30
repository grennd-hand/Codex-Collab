import type { Message, MessageDeliveryStatus } from "@codex-collab/protocol";

const deliveryRank: Record<MessageDeliveryStatus, number> = {
  queued: 1,
  submitted: 2,
  completed: 3,
  failed: 3,
};

function mergeMessage(current: Message, incoming: Message): Message {
  const currentRank = current.deliveryStatus
    ? deliveryRank[current.deliveryStatus]
    : 0;
  const incomingRank = incoming.deliveryStatus
    ? deliveryRank[incoming.deliveryStatus]
    : 0;
  if (
    incomingRank > currentRank ||
    (incomingRank === currentRank && incomingRank < deliveryRank.completed)
  ) {
    return incoming;
  }

  return {
    ...incoming,
    deliveryStatus: current.deliveryStatus,
    codexTurnId: current.codexTurnId ?? incoming.codexTurnId,
    completedAt: current.completedAt ?? incoming.completedAt,
  };
}

export function mergeConversationMessages(
  current: readonly Message[],
  incoming: readonly Message[],
): Message[] {
  const mergedById = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) {
    const existing = mergedById.get(message.id);
    mergedById.set(
      message.id,
      existing ? mergeMessage(existing, message) : message,
    );
  }
  return [...mergedById.values()].sort(
    (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt),
  );
}
