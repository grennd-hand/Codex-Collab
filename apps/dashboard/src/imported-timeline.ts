import type { CodexRecordEntry, Message } from "@codex-collab/protocol";

export type ImportedTimelineItem =
  | {
      kind: "message";
      entry: CodexRecordEntry;
    }
  | {
      kind: "execution";
      id: string;
      entries: CodexRecordEntry[];
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

const FILES_HEADER = "# Files mentioned by the user:";
const REQUEST_HEADER = "## My request for Codex:";

function isAbsoluteLocalPath(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value);
}

export function sanitizeImportedUserText(text: string): string {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== FILES_HEADER) return text;

  const requestHeaderIndex = lines.indexOf(REQUEST_HEADER, 1);
  if (requestHeaderIndex < 0) return text;

  let attachmentCount = 0;
  let index = 1;
  while (index < requestHeaderIndex) {
    if (lines[index]?.trim() === "") {
      index += 1;
      continue;
    }

    const heading = lines[index];
    const path = lines[index + 1];
    if (
      !heading ||
      !/^## .+:$/.test(heading) ||
      !path ||
      !isAbsoluteLocalPath(path) ||
      index + 1 >= requestHeaderIndex
    ) {
      return text;
    }

    attachmentCount += 1;
    index += 2;
  }

  const body = lines.slice(requestHeaderIndex + 1).join("\n").trim();
  return attachmentCount > 0 && body ? body : text;
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
    if (entry.role === "user" || entry.role === "assistant") {
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
  const reasoningCount = entries.filter((entry) => entry.role === "reasoning").length;
  const commandCount = entries.filter((entry) => entry.role === "command").length;
  const parts = [
    reasoningCount > 0 ? `${reasoningCount} 条推理` : null,
    commandCount > 0 ? `${commandCount} 条命令` : null,
  ].filter((part): part is string => Boolean(part));

  return parts.join("，");
}
