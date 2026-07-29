import type { EditorTabState } from "./ide-tab-state.js";
import type { IdeWorkspaceFile } from "./types.js";

export interface IdeTaskStateSnapshot {
  activePath: string | null;
  tabs: EditorTabState[];
  workspaceDataScope: string;
}

const taskSnapshots = new Map<string, IdeTaskStateSnapshot>();

function cloneTab(tab: EditorTabState): EditorTabState {
  return {
    ...tab,
    conflict: tab.conflict
      ? { ...tab.conflict, remote: { ...tab.conflict.remote } }
      : null,
  };
}

function normalizeTabForSnapshot(tab: EditorTabState): EditorTabState {
  const clone = cloneTab(tab);
  if (clone.status === "loading") {
    return {
      ...clone,
      status: "error",
      error: "文件读取因任务切换或连接中断，请重试。",
    };
  }
  if (clone.saving) {
    return {
      ...clone,
      saving: false,
      savedNotice: false,
      saveError: "保存结果尚未确认，请重新连接后重试。",
    };
  }
  return clone;
}

export function readIdeTaskState(
  taskScope: string,
  workspaceDataScope?: string,
): IdeTaskStateSnapshot | null {
  const snapshot = taskSnapshots.get(taskScope);
  if (
    !snapshot ||
    (workspaceDataScope !== undefined &&
      snapshot.workspaceDataScope !== workspaceDataScope)
  ) {
    return null;
  }
  return { ...snapshot, tabs: snapshot.tabs.map(cloneTab) };
}

export function writeIdeTaskState(
  taskScope: string,
  snapshot: IdeTaskStateSnapshot,
): void {
  taskSnapshots.set(taskScope, {
    ...snapshot,
    tabs: snapshot.tabs.map(normalizeTabForSnapshot),
  });
}

export function releaseIdeTaskStates(workspaceScope: string): void {
  for (const [taskScope, snapshot] of taskSnapshots) {
    if (snapshot.workspaceDataScope === workspaceScope) {
      taskSnapshots.delete(taskScope);
    }
  }
}

export function reconcileTabsWithWorkspaceFiles(
  tabs: EditorTabState[],
  files: readonly IdeWorkspaceFile[],
): EditorTabState[] {
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  let changed = false;
  const next = tabs.map((tab) => {
    if (tab.status !== "ready") return tab;
    const remote = filesByPath.get(tab.path);
    const remoteState: EditorTabState["remoteState"] = !remote
      ? "deleted-remotely"
      : remote.sha256 === tab.sha256
        ? "current"
        : "stale";
    const remoteSha256 = remote?.sha256 ?? null;
    if (
      tab.remoteState === remoteState &&
      tab.remoteSha256 === remoteSha256
    ) {
      return tab;
    }
    changed = true;
    return { ...tab, remoteState, remoteSha256 };
  });
  return changed ? next : tabs;
}

export function canReloadStaleTab(tab: EditorTabState): boolean {
  return (
    tab.status === "ready" &&
    tab.remoteState === "stale" &&
    tab.value === tab.savedValue
  );
}
