import {
  sanitizeCodexUserMessageText,
  type CodexRecordEntry,
  type Message,
} from "@codex-collab/protocol";

export type ImportedTimelineItem =
  | {
      kind: "message";
      entry: CodexRecordEntry;
    }
  | {
      kind: "execution";
      id: string;
      entries: CodexRecordEntry[];
      completedAt?: string;
    };

export type UnifiedTimelineItem =
  | {
      kind: "imported";
      item: ImportedTimelineItem;
    }
  | {
      kind: "shared";
      message: Message;
    };

interface CollabCommandEnvelope {
  commandId: string | null;
  member: string;
  body: string;
}

export function splitConversationMessages(messages: readonly Message[]): {
  chatMessages: Message[];
  codexMessages: Message[];
} {
  const chatMessages: Message[] = [];
  const codexMessages: Message[] = [];
  for (const message of messages) {
    (message.kind === "chat" ? chatMessages : codexMessages).push(message);
  }
  return { chatMessages, codexMessages };
}

export function sanitizeImportedUserText(text: string): string {
  return sanitizeCodexUserMessageText(text);
}

export function parseCollabCommandEnvelope(
  text: string,
): CollabCommandEnvelope | null {
  const current = text.match(
    /^\[Codex Collab command: ([^\]]+)\]\n\[Codex Collab member: ([^\]]+)\]\n\n([\s\S]*)$/,
  );
  if (current) {
    return {
      commandId: current[1] ?? null,
      member: current[2] ?? "",
      body: current[3] ?? "",
    };
  }
  const legacy = text.match(/^\[Codex Collab member: ([^\]]+)\]\n\n([\s\S]*)$/);
  return legacy
    ? {
        commandId: null,
        member: legacy[1] ?? "",
        body: legacy[2] ?? "",
      }
    : null;
}

export function buildImportedTimeline(history: CodexRecordEntry[]): ImportedTimelineItem[] {
  const timeline: ImportedTimelineItem[] = [];

  for (const entry of history) {
    const isCommentary = entry.role === "assistant" && entry.phase === "commentary";
    if (entry.role === "user" || (entry.role === "assistant" && !isCommentary)) {
      const previous = timeline.at(-1);
      if (
        entry.role === "assistant" &&
        previous?.kind === "execution" &&
        entry.createdAt
      ) {
        previous.completedAt = entry.createdAt;
      }
      timeline.push({
        kind: "message",
        entry:
          entry.role === "user"
            ? { ...entry, text: sanitizeImportedUserText(entry.text) }
            : entry,
      });
      continue;
    }

    const previous = timeline.at(-1);
    if (previous?.kind === "execution") {
      previous.entries.push(entry);
    } else {
      timeline.push({
        kind: "execution",
        id: `execution-${entry.id}`,
        entries: [entry],
      });
    }
  }

  return timeline;
}

export function buildUnifiedTimeline(
  history: CodexRecordEntry[],
  messages: Message[],
): UnifiedTimelineItem[] {
  const commandMessages = messages.filter(
    (message) => message.kind === "codex_prompt",
  );
  const claimedMessageIds = new Set<string>();
  const filteredHistory = history.filter((entry) => {
    if (entry.role !== "user") return true;
    const envelope = parseCollabCommandEnvelope(entry.text);
    const visibleText = envelope?.body ?? sanitizeImportedUserText(entry.text);
    const exact = commandMessages.find(
      (message) =>
        !claimedMessageIds.has(message.id) &&
        (message.id === entry.id ||
          (envelope?.commandId !== null &&
            envelope?.commandId !== undefined &&
            message.id === envelope.commandId)),
    );
    const compatible =
      exact ??
      commandMessages
        .filter(
          (message) =>
            !claimedMessageIds.has(message.id) &&
            (!envelope || message.senderDisplayName === envelope.member) &&
            (visibleText === message.body ||
              visibleText.startsWith(`${message.body}\n`)),
        )
        .map((message) => ({
          message,
          distance:
            entry.createdAt === null
              ? Number.POSITIVE_INFINITY
              : Math.abs(
                  Date.parse(entry.createdAt) - Date.parse(message.createdAt),
                ),
        }))
        .filter(({ distance }) => distance <= 120_000)
        .sort((left, right) => left.distance - right.distance)[0]?.message;
    if (!compatible) return true;
    claimedMessageIds.add(compatible.id);
    return false;
  });

  const candidates: Array<{
    item: UnifiedTimelineItem;
    timestamp: number;
    order: number;
  }> = [];
  let order = 0;
  for (const item of buildImportedTimeline(filteredHistory)) {
    const createdAt =
      item.kind === "message"
        ? item.entry.createdAt
        : item.entries.find((entry) => entry.createdAt)?.createdAt ?? null;
    candidates.push({
      item: { kind: "imported", item },
      timestamp: createdAt ? Date.parse(createdAt) : 0,
      order: order++,
    });
  }
  for (const message of messages) {
    candidates.push({
      item: { kind: "shared", message },
      timestamp: Date.parse(message.createdAt),
      order: order++,
    });
  }

  return candidates
    .sort(
      (left, right) =>
        left.timestamp - right.timestamp || left.order - right.order,
    )
    .map((candidate) => candidate.item);
}

export function executionDetailLabel(entries: CodexRecordEntry[]): string {
  const processCount = entries.filter(
    (entry) => entry.role === "reasoning" || entry.phase === "commentary",
  ).length;
  const commandCount = entries.filter((entry) => entry.role === "command").length;
  const parts = [
    processCount > 0 ? `${processCount} 条处理` : null,
    commandCount > 0 ? `${commandCount} 条命令` : null,
  ].filter((part): part is string => Boolean(part));

  return parts.join("，");
}
