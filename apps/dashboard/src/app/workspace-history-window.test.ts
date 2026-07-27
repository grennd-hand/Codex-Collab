import { describe, expect, it } from "vitest";
import type { WorkspaceHistoryPage } from "@codex-collab/protocol";
import {
  beginLatestHistoryLoad,
  beginOlderHistoryLoad,
  createWorkspaceHistoryWindow,
  prependOlderHistoryPage,
  reconcileLatestHistoryPage,
  workspaceHistoryEntries,
} from "./workspace-history-window.js";

function page(
  keys: string[],
  options: Partial<WorkspaceHistoryPage> = {},
): WorkspaceHistoryPage {
  return {
    selectedThreadId: "thread-1",
    items: keys.map((key) => ({
      key,
      entry: { id: key, role: "assistant", text: key, createdAt: null },
    })),
    totalCount: keys.length,
    hasOlder: false,
    olderCursor: null,
    syncedAt: "2026-07-27T00:00:00.000Z",
    ...options,
  };
}

describe("workspace history window", () => {
  it("starts with only the most recent page", () => {
    const loading = beginLatestHistoryLoad(
      createWorkspaceHistoryWindow(null, null),
      "session-1",
      "thread-1",
    );
    const result = reconcileLatestHistoryPage(
      loading,
      "session-1",
      page(["61", "62"], {
        totalCount: 62,
        hasOlder: true,
        olderCursor: "before-61",
      }),
    );
    expect(workspaceHistoryEntries(result).map((entry) => entry.id)).toEqual([
      "61",
      "62",
    ]);
    expect(result).toMatchObject({ hasOlder: true, initialLoading: false });
  });

  it("prepends an older page without dropping duplicate record ids", () => {
    const initial = reconcileLatestHistoryPage(
      beginLatestHistoryLoad(
        createWorkspaceHistoryWindow(null, null),
        "session-1",
        "thread-1",
      ),
      "session-1",
      page(["same:2", "new"], {
        totalCount: 3,
        hasOlder: true,
        olderCursor: "before-same-2",
      }),
    );
    const loading = beginOlderHistoryLoad(initial);
    const result = prependOlderHistoryPage(
      loading,
      "session-1",
      "before-same-2",
      page(["same:1"], { totalCount: 3 }),
    );
    expect(result.items.map((item) => item.key)).toEqual([
      "same:1",
      "same:2",
      "new",
    ]);
  });

  it("reconciles a changed latest page while retaining the loaded older prefix", () => {
    const current = {
      ...createWorkspaceHistoryWindow("session-1", "thread-1"),
      items: page(["old", "running", "tail"]).items,
      totalCount: 3,
      olderCursor: "before-old",
      hasOlder: true,
    };
    const updatedPage = page(["running", "tail", "new"], { totalCount: 4 });
    updatedPage.items[0] = {
      ...updatedPage.items[0]!,
      entry: {
        id: "running",
        role: "assistant",
        text: "completed",
        createdAt: null,
      },
    };
    const result = reconcileLatestHistoryPage(current, "session-1", updatedPage);
    expect(result.items.map((item) => item.key)).toEqual([
      "old",
      "running",
      "tail",
      "new",
    ]);
    expect(result.items[1]?.entry.text).toBe("completed");
    expect(result.olderCursor).toBe("before-old");
  });

  it("ignores a page returned for an obsolete task", () => {
    const current = createWorkspaceHistoryWindow("session-1", "thread-2");
    expect(reconcileLatestHistoryPage(current, "session-1", page(["old"]))).toBe(
      current,
    );
  });
});
