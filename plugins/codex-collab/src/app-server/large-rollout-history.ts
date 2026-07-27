import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { CodexRecordEntry } from "@codex-collab/protocol";
import { limitRecordEntries } from "./history-common.js";
import {
  extractCodexRolloutEntries,
  extractCodexRolloutMessageEntry,
} from "./rollout-history-parser.js";
import {
  MAX_RECENT_ROLLOUT_BYTES,
  readRecentRolloutLines,
} from "./rollout-reader.js";

interface LargeRolloutCacheEntry {
  threadId: string;
  size: number;
  conversation: CodexRecordEntry[];
  history: CodexRecordEntry[];
}

function mergeConversationEntries(
  current: CodexRecordEntry[],
  recent: CodexRecordEntry[],
): CodexRecordEntry[] {
  const recentById = new Map(recent.map((entry) => [entry.id, entry]));
  const merged = current.map((entry) => recentById.get(entry.id) ?? entry);
  const currentIds = new Set(current.map((entry) => entry.id));
  for (const entry of recent) {
    if (!currentIds.has(entry.id)) merged.push(entry);
  }
  return merged;
}

function combineConversationAndRecent(
  conversation: CodexRecordEntry[],
  recent: CodexRecordEntry[],
): CodexRecordEntry[] {
  const recentIds = new Set(recent.map((entry) => entry.id));
  return limitRecordEntries([
    ...conversation.filter((entry) => !recentIds.has(entry.id)),
    ...recent,
  ]);
}

async function readFullConversation(
  path: string,
  threadId: string,
): Promise<CodexRecordEntry[]> {
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  const conversation: CodexRecordEntry[] = [];
  for await (const line of lines) {
    const entry = extractCodexRolloutMessageEntry(
      line,
      threadId,
      conversation.length,
    );
    if (entry) conversation.push(entry);
  }
  return conversation;
}

export class LargeRolloutHistoryReader {
  private readonly cache = new Map<string, LargeRolloutCacheEntry>();

  constructor(private readonly recentByteLimit = MAX_RECENT_ROLLOUT_BYTES) {}

  async read(
    path: string,
    size: number,
    threadId: string,
  ): Promise<CodexRecordEntry[]> {
    const cached = this.cache.get(path);
    if (cached?.threadId === threadId && cached.size === size) {
      return cached.history;
    }

    const recentLines = await readRecentRolloutLines(
      path,
      size,
      this.recentByteLimit,
    );
    const recent = extractCodexRolloutEntries(recentLines, threadId);
    const recentConversation = recent.filter(
      (entry) => entry.role === "user" || entry.role === "assistant",
    );
    const conversation =
      cached?.threadId === threadId && size > cached.size
        ? mergeConversationEntries(cached.conversation, recentConversation)
        : await readFullConversation(path, threadId);
    const history = combineConversationAndRecent(conversation, recent);
    this.cache.set(path, { threadId, size, conversation, history });
    return history;
  }
}
