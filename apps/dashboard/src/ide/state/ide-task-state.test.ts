import { describe, expect, it } from "vitest";
import { createReadyTab } from "./ide-tab-state.js";
import {
  canReloadStaleTab,
  readIdeTaskState,
  reconcileTabsWithWorkspaceFiles,
  releaseIdeTaskStates,
  writeIdeTaskState,
} from "./ide-task-state.js";

function document(path: string, sha256: string, content = "saved") {
  return {
    path,
    content,
    size: content.length,
    modifiedAt: "2026-07-28T00:00:00.000Z",
    sha256,
  };
}

describe("IDE task state", () => {
  it("keeps independent tabs and dirty drafts for each selected task", () => {
    const taskA = "task-a";
    const taskB = "task-b";
    const dirtyTab = {
      ...createReadyTab(document("src/App.tsx", "sha-a")),
      value: "local draft",
    };
    writeIdeTaskState(taskA, {
      activePath: dirtyTab.path,
      tabs: [dirtyTab],
      workspaceDataScope: "workspace",
    });
    writeIdeTaskState(taskB, {
      activePath: null,
      tabs: [],
      workspaceDataScope: "workspace",
    });

    expect(readIdeTaskState(taskA)?.tabs[0]?.value).toBe("local draft");
    expect(readIdeTaskState(taskB)?.tabs).toEqual([]);
    expect(readIdeTaskState(taskA, "other-workspace")).toBeNull();
    releaseIdeTaskStates("workspace");
  });

  it("releases every task only when its workspace is released", () => {
    writeIdeTaskState("task-a", {
      activePath: null,
      tabs: [],
      workspaceDataScope: "workspace-a",
    });
    writeIdeTaskState("task-b", {
      activePath: null,
      tabs: [],
      workspaceDataScope: "workspace-b",
    });

    releaseIdeTaskStates("workspace-a");

    expect(readIdeTaskState("task-a")).toBeNull();
    expect(readIdeTaskState("task-b")).not.toBeNull();
    releaseIdeTaskStates("workspace-b");
  });

  it("marks changed and deleted remote files without discarding a draft", () => {
    const changed = {
      ...createReadyTab(document("changed.ts", "old")),
      value: "unsaved local edit",
    };
    const deleted = createReadyTab(document("deleted.ts", "old"));

    const reconciled = reconcileTabsWithWorkspaceFiles(
      [changed, deleted],
      [document("changed.ts", "new")],
    );

    expect(reconciled[0]).toMatchObject({
      value: "unsaved local edit",
      savedValue: "saved",
      remoteState: "stale",
      remoteSha256: "new",
    });
    expect(reconciled[1]).toMatchObject({
      value: "saved",
      remoteState: "deleted-remotely",
      remoteSha256: null,
    });
  });

  it("keeps the same tab collection when remote metadata is unchanged", () => {
    const tab = createReadyTab(document("stable.ts", "same"));
    const tabs = [tab];

    expect(
      reconcileTabsWithWorkspaceFiles(tabs, [document("stable.ts", "same")]),
    ).toBe(tabs);
  });

  it("restores transient reads and saves as retryable states", () => {
    const loading = {
      ...createReadyTab(document("loading.ts", "sha")),
      status: "loading" as const,
    };
    const saving = {
      ...createReadyTab(document("saving.ts", "sha")),
      value: "dirty",
      saving: true,
    };
    writeIdeTaskState("transient-task", {
      activePath: loading.path,
      tabs: [loading, saving],
      workspaceDataScope: "transient-workspace",
    });

    expect(readIdeTaskState("transient-task")?.tabs).toMatchObject([
      { status: "error", error: expect.stringContaining("请重试") },
      { status: "ready", saving: false, saveError: expect.stringContaining("尚未确认") },
    ]);
    releaseIdeTaskStates("transient-workspace");
  });

  it("reloads only clean stale tabs so a dirty draft is never overwritten", () => {
    const stale = {
      ...createReadyTab(document("stale.ts", "old")),
      remoteState: "stale" as const,
      remoteSha256: "new",
    };

    expect(canReloadStaleTab(stale)).toBe(true);
    expect(canReloadStaleTab({ ...stale, value: "dirty" })).toBe(false);
    expect(canReloadStaleTab({ ...stale, remoteState: "current" })).toBe(false);
  });
});
