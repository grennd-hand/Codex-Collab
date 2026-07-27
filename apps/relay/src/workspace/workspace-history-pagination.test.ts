import { describe, expect, it } from "vitest";
import { ProtocolError, type CodexRecordEntry } from "@codex-collab/protocol";
import {
  MAX_WORKSPACE_HISTORY_PAGE_SIZE,
  paginateWorkspaceHistory,
} from "./workspace-history-pagination.js";

function entry(
  id: string,
  role: CodexRecordEntry["role"] = "assistant",
): CodexRecordEntry {
  return {
    id,
    role,
    phase: role === "assistant" ? "final_answer" : "commentary",
    text: id,
    createdAt: "2026-07-27T00:00:00.000Z",
  };
}

describe("paginateWorkspaceHistory", () => {
  it("returns latest records first and continues from an opaque cursor", () => {
    const history = Array.from({ length: 95 }, (_, index) =>
      entry(`entry-${index}`),
    );
    const latest = paginateWorkspaceHistory({
      sessionId: "session-1",
      threadId: "thread-1",
      history,
      syncedAt: "2026-07-27T00:00:00.000Z",
    });
    const older = paginateWorkspaceHistory({
      sessionId: "session-1",
      threadId: "thread-1",
      history,
      syncedAt: "2026-07-27T00:00:00.000Z",
      before: latest.olderCursor,
    });

    expect(latest.items).toHaveLength(40);
    expect(latest.items[0]?.entry.id).toBe("entry-55");
    expect(older.items).toHaveLength(40);
    expect(older.items[0]?.entry.id).toBe("entry-15");
  });

  it("keeps duplicate entry ids distinct and execution groups stable", () => {
    const page = paginateWorkspaceHistory({
      sessionId: "session-1",
      threadId: "thread-1",
      history: [
        entry("duplicate", "reasoning"),
        entry("duplicate", "command"),
        entry("answer"),
      ],
      syncedAt: null,
    });

    expect(page.items[0]?.key).not.toBe(page.items[1]?.key);
    expect(page.items[0]?.groupKey).toBe(page.items[1]?.groupKey);
    expect(page.items[2]?.groupKey).toBeNull();
  });

  it("rejects unsafe limits and cursors from another task", () => {
    expect(() =>
      paginateWorkspaceHistory({
        sessionId: "session-1",
        threadId: "thread-1",
        history: [],
        syncedAt: null,
        limit: MAX_WORKSPACE_HISTORY_PAGE_SIZE + 1,
      }),
    ).toThrowError(ProtocolError);

    const latest = paginateWorkspaceHistory({
      sessionId: "session-1",
      threadId: "thread-1",
      history: Array.from({ length: 41 }, (_, index) => entry(`entry-${index}`)),
      syncedAt: null,
    });
    expect(() =>
      paginateWorkspaceHistory({
        sessionId: "session-1",
        threadId: "thread-2",
        history: Array.from({ length: 41 }, (_, index) => entry(`entry-${index}`)),
        syncedAt: null,
        before: latest.olderCursor,
      }),
    ).toThrowError(ProtocolError);
  });
});
