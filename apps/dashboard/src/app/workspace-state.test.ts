import { describe, expect, it } from "vitest";
import type { WorkspaceOverview, WorkspaceSummary } from "@codex-collab/protocol";
import { mergeWorkspaceHistory, mergeWorkspaceOverview } from "./workspace-state.js";

const overview: WorkspaceOverview = {
  hostConnected: true,
  hostDeviceLabel: "Owner PC",
  rootLabel: "Project",
  threads: [],
  selectedThreadId: "thread-1",
  selectedThread: null,
  historyCount: 1,
  files: [],
  codexRuntimeStatus: "idle",
  syncedAt: "2026-07-27T00:00:00.000Z",
};

const current: WorkspaceSummary = {
  ...overview,
  history: [{ id: "old", role: "assistant", text: "Keep me", createdAt: null }],
};

describe("compact workspace state", () => {
  it("keeps loaded history when an overview refresh targets the same task", () => {
    expect(mergeWorkspaceOverview(current, overview).history).toEqual(current.history);
  });

  it("drops stale history when the selected task changes", () => {
    expect(
      mergeWorkspaceOverview(current, {
        ...overview,
        selectedThreadId: "thread-2",
      }).history,
    ).toEqual([]);
  });

  it("merges matching history without replacing the newer overview", () => {
    expect(
      mergeWorkspaceHistory(overview, {
        selectedThreadId: "thread-1",
        history: [{ id: "new", role: "user", text: "Fresh", createdAt: null }],
        syncedAt: "2026-07-27T00:00:01.000Z",
      }),
    ).toMatchObject({
      history: [{ text: "Fresh" }],
      historyCount: 1,
      syncedAt: "2026-07-27T00:00:01.000Z",
    });
  });

  it("rejects history returned for a different task", () => {
    expect(
      mergeWorkspaceHistory(overview, {
        selectedThreadId: "thread-2",
        history: [],
        syncedAt: null,
      }),
    ).toBeNull();
  });
});
