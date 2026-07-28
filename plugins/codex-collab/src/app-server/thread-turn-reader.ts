import type { CodexTurn } from "./thread-history-parser.js";

export type AppServerRequest = (method: string, params: unknown) => Promise<unknown>;

export async function readCodexTurns(
  request: AppServerRequest,
  threadId: string,
  maxTurns = Number.POSITIVE_INFINITY,
): Promise<CodexTurn[]> {
  const turns: CodexTurn[] = [];
  const observedCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const response = (await request("thread/turns/list", {
      threadId,
      cursor,
      limit: 100,
      sortDirection: "asc",
      itemsView: "full",
    })) as { data?: CodexTurn[]; nextCursor?: string | null };
    turns.push(...(response.data ?? []));
    cursor = response.nextCursor ?? null;
    if (cursor && observedCursors.has(cursor)) {
      throw new Error("Codex app-server repeated a turn history cursor");
    }
    if (cursor) observedCursors.add(cursor);
  } while (cursor && turns.length < maxTurns);
  return turns;
}
