import {
  sanitizeCodexAssistantMessageText,
  sanitizeCodexUserMessageText,
  type CodexRecordEntry,
  type Message,
  type WorkspaceHistoryPageItem,
} from "@codex-collab/protocol";

export type ImportedTimelineItem =
  | {
      kind: "message";
      entry: CodexRecordEntry;
      key?: string;
    }
  | {
      kind: "execution";
      id: string;
      entries: CodexRecordEntry[];
      entryKeys?: Array<string | null>;
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

export type ThreadAttributedMessage = Message & {
  workspaceThreadId?: string | null;
};

export interface ThreadMessageSelection {
  currentThreadMessages: ThreadAttributedMessage[];
  unassignedMessages: ThreadAttributedMessage[];
}

interface CollabCommandEnvelope {
  commandId: string | null;
  member: string;
  body: string;
}

type TimelineHistoryEntry = CodexRecordEntry | WorkspaceHistoryPageItem;

function keyedHistoryEntry(item: TimelineHistoryEntry): {
  key: string | null;
  groupKey: string | null;
  entry: CodexRecordEntry;
} {
  return "entry" in item
    ? { key: item.key, groupKey: item.groupKey ?? null, entry: item.entry }
    : { key: null, groupKey: null, entry: item };
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

export function selectCodexMessagesForThread(
  messages: readonly ThreadAttributedMessage[],
  selectedThreadId: string | null | undefined,
): ThreadMessageSelection {
  const currentThreadMessages: ThreadAttributedMessage[] = [];
  const unassignedMessages: ThreadAttributedMessage[] = [];

  for (const message of messages) {
    if (message.kind === "chat") continue;
    const workspaceThreadId = message.workspaceThreadId?.trim() || null;
    if (!workspaceThreadId) {
      unassignedMessages.push(message);
      continue;
    }
    if (selectedThreadId && workspaceThreadId === selectedThreadId) {
      currentThreadMessages.push(message);
    }
  }

  return { currentThreadMessages, unassignedMessages };
}

export function sanitizeImportedUserText(text: string): string {
  const envelope = parseCollabCommandEnvelope(text);
  return sanitizeCodexUserMessageText(envelope?.body ?? text);
}

export function sanitizeImportedAssistantText(text: string): string {
  return sanitizeCodexAssistantMessageText(text);
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

export function buildImportedTimeline(
  history: readonly TimelineHistoryEntry[],
): ImportedTimelineItem[] {
  const timeline: ImportedTimelineItem[] = [];

  for (const historyItem of history) {
    const { key, groupKey, entry } = keyedHistoryEntry(historyItem);
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
      const visibleText =
        entry.role === "user"
          ? sanitizeImportedUserText(entry.text)
          : sanitizeImportedAssistantText(entry.text);
      if (!visibleText) continue;
      timeline.push({
        kind: "message",
        entry: visibleText === entry.text ? entry : { ...entry, text: visibleText },
        ...(key ? { key } : {}),
      });
      continue;
    }

    const previous = timeline.at(-1);
    if (previous?.kind === "execution") {
      const previousEntryCount = previous.entries.length;
      previous.entries.push(entry);
      if (previous.entryKeys || key) {
        previous.entryKeys ??= Array<string | null>(previousEntryCount).fill(null);
        previous.entryKeys.push(key);
      }
    } else {
      timeline.push({
        kind: "execution",
        id: groupKey ?? `execution-${key ?? entry.id}`,
        entries: [entry],
        ...(key ? { entryKeys: [key] } : {}),
      });
    }
  }

  return timeline;
}

export function buildUnifiedTimeline(
  history: readonly TimelineHistoryEntry[],
  messages: readonly Message[],
): UnifiedTimelineItem[] {
  const commandMessages = messages.filter(
    (message) => message.kind === "codex_prompt",
  );
  const claimedMessageIds = new Set<string>();
  const filteredHistory = history.filter((historyItem) => {
    const { entry } = keyedHistoryEntry(historyItem);
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
    timestamp: number | null;
    sourcePriority: number;
    order: number;
  }> = [];
  const parseTimestamp = (value: string | null | undefined): number | null => {
    if (!value) return null;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
  };
  let order = 0;
  const importedTimeline = buildImportedTimeline(filteredHistory);
  const importedTimestamps = importedTimeline.map((item) => {
    const createdAt =
      item.kind === "message"
        ? item.entry.createdAt
        : item.entries.find((entry) => entry.createdAt)?.createdAt ?? null;
    return parseTimestamp(createdAt);
  });
  let lastImportedTimestamp: number | null = null;
  for (let index = 0; index < importedTimeline.length; index += 1) {
    const item = importedTimeline[index]!;
    let timestamp = importedTimestamps[index] ?? null;
    if (timestamp === null) {
      let previousIndex = index - 1;
      while (previousIndex >= 0 && importedTimestamps[previousIndex] === null) {
        previousIndex -= 1;
      }
      let nextIndex = index + 1;
      while (
        nextIndex < importedTimestamps.length &&
        importedTimestamps[nextIndex] === null
      ) {
        nextIndex += 1;
      }
      const previousTimestamp =
        previousIndex >= 0 ? importedTimestamps[previousIndex] ?? null : null;
      const nextTimestamp =
        nextIndex < importedTimestamps.length
          ? importedTimestamps[nextIndex] ?? null
          : null;
      if (previousTimestamp !== null && nextTimestamp !== null) {
        const fraction = (index - previousIndex) / (nextIndex - previousIndex);
        timestamp =
          previousTimestamp + (nextTimestamp - previousTimestamp) * fraction;
      } else if (nextTimestamp !== null) {
        timestamp = nextTimestamp - (nextIndex - index) / 1_000;
      } else if (previousTimestamp !== null) {
        timestamp = previousTimestamp + (index - previousIndex) / 1_000;
      }
    }
    if (
      timestamp !== null &&
      lastImportedTimestamp !== null &&
      timestamp <= lastImportedTimestamp
    ) {
      timestamp = lastImportedTimestamp + 1 / 1_000;
    }
    if (timestamp !== null) lastImportedTimestamp = timestamp;
    candidates.push({
      item: { kind: "imported", item },
      timestamp,
      sourcePriority: 1,
      order: order++,
    });
  }
  for (const message of messages) {
    candidates.push({
      item: { kind: "shared", message },
      timestamp: parseTimestamp(message.createdAt),
      sourcePriority: 0,
      order: order++,
    });
  }

  return candidates
    .sort((left, right) => {
      if (left.timestamp !== null && right.timestamp !== null) {
        const timestampDifference = left.timestamp - right.timestamp;
        if (timestampDifference !== 0) return timestampDifference;
      } else if (left.timestamp !== null) {
        return -1;
      } else if (right.timestamp !== null) {
        return 1;
      }
      return (
        left.sourcePriority - right.sourcePriority || left.order - right.order
      );
    })
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
