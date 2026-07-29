import { useState, type ReactNode } from "react";
import type { DashboardViewModel } from "../../../dashboard/src/app/dashboard-view-model.js";
import { ErrorBanner } from "../../../dashboard/src/app/shell/ErrorBanner.js";
import { ActivityPanel } from "../../../dashboard/src/features/activity/ActivityPanel.js";
import { useIdeWorkspaceRelease } from "../../../dashboard/src/ide/state/ide-workspace-lifecycle.js";
import {
  taskUiScope,
  workspaceDataScope,
} from "../../../dashboard/src/ide/state/workspace-file-cache.js";
import { ResizableSplitPane } from "../../../dashboard/src/layout/split-pane/ResizableSplitPane.js";
import { useWorkspacePanelVisibility } from "../../../dashboard/src/layout/workspace/useWorkspacePanelVisibility.js";
import {
  DesktopActivityRail,
  type DesktopSidebarMode,
} from "./DesktopActivityRail.js";
import { DesktopCodexPane } from "../panes/DesktopCodexPane.js";
import { DesktopCollaborationPane } from "../panes/DesktopCollaborationPane.js";
import { DesktopCommandBar } from "./DesktopCommandBar.js";
import { DesktopFilesPane } from "../panes/DesktopFilesPane.js";

function statusTime(value: string | null | undefined): string {
  if (!value) return "尚未同步";
  return new Date(value).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function DesktopWorkspaceShell({ model }: { model: DashboardViewModel }) {
  const [activeSidebar, setActiveSidebar] =
    useState<DesktopSidebarMode | null>("collaboration");
  const summary = model.workspaceHistory.summary;
  const dataScope = workspaceDataScope(
    model.session?.id ?? "anonymous",
    summary?.hostDeviceLabel,
    summary?.rootLabel,
    summary?.hostGeneration,
  );
  const taskScope = taskUiScope(
    model.session?.id ?? "anonymous",
    summary?.rootLabel,
    summary?.selectedThreadId,
    summary?.hostGeneration,
  );
  useIdeWorkspaceRelease(dataScope);
  const panels = useWorkspacePanelVisibility({
    allowCollaborationWithEditor: true,
    editorExpanded: model.workspaceFiles.editorExpanded,
    scope: taskScope,
    setEditorExpanded: model.workspaceFiles.setEditorExpanded,
    workspaceConnected: model.workspaceConnected,
  });
  const filesVisible = model.workspaceConnected && panels.filesVisible;
  const visibleSidebar =
    activeSidebar === "collaboration" && !panels.collaborationVisible
      ? null
      : activeSidebar;

  const selectSidebar = (mode: DesktopSidebarMode) => {
    if (mode === "collaboration") {
      if (visibleSidebar === mode) {
        setActiveSidebar(null);
        panels.toggleCollaboration();
        return;
      }
      setActiveSidebar(mode);
      if (!panels.collaborationVisible) panels.toggleCollaboration();
      return;
    }
    setActiveSidebar((current) => (current === mode ? null : mode));
  };

  let sidebar: ReactNode = null;
  if (visibleSidebar === "collaboration") {
    sidebar = <DesktopCollaborationPane model={model} />;
  } else if (visibleSidebar === "activity") {
    sidebar = <ActivityPanel activities={model.activities} />;
  }

  const codexPane = <DesktopCodexPane model={model} />;
  const taskWorkspace = filesVisible ? (
    <ResizableSplitPane
      className="desktop-main-split"
      primary={
        <DesktopFilesPane
          dataScope={dataScope}
          model={model}
          taskScope={taskScope}
        />
      }
      secondary={codexPane}
      defaultPrimarySize={760}
      minPrimarySize={440}
      maxPrimarySize={1_120}
      minSecondarySize={360}
      separatorLabel="调整项目 IDE 和 Codex 任务宽度"
      primaryLabel="项目 IDE"
      secondaryLabel="Codex 任务"
      storageKey={`codex-collab:desktop:ide-task:${taskScope}`}
    />
  ) : (
    codexPane
  );
  const workspace = sidebar ? (
    <ResizableSplitPane
      className="desktop-sidebar-split"
      primary={sidebar}
      secondary={taskWorkspace}
      defaultPrimarySize={300}
      minPrimarySize={248}
      maxPrimarySize={420}
      minSecondarySize={760}
      separatorLabel="调整协作侧栏和工作区宽度"
      primaryLabel={visibleSidebar === "activity" ? "最近活动" : "协作聊天"}
      secondaryLabel="项目 IDE 与 Codex 任务"
      storageKey={`codex-collab:desktop:sidebar:${taskScope}`}
    />
  ) : (
    taskWorkspace
  );

  return (
    <div className="desktop-shell">
      <DesktopCommandBar model={model} />
      <div className="desktop-error-slot">
        <ErrorBanner message={model.error} onDismiss={() => model.setError(null)} />
      </div>
      <div className="desktop-workbench">
        <DesktopActivityRail
          activeSidebar={visibleSidebar}
          filesVisible={filesVisible}
          pendingMemberCount={model.pendingMemberCount}
          workspaceAvailable={model.workspaceConnected}
          workspaceConfigurable={Boolean(
            model.approved &&
              (model.member?.role === "owner" || !model.workspaceConnected),
          )}
          onSelectSidebar={selectSidebar}
          onShowFiles={() => {
            if (!filesVisible) panels.toggleFiles();
            setActiveSidebar(null);
          }}
          onOpenWorkspace={() => void model.workspaceConnection.openDialog()}
        />
        <section className="desktop-workspace-stage" aria-label="主人工作台">
          {workspace}
        </section>
      </div>
      <footer className="desktop-statusbar" aria-label="工作台状态">
        <span>{model.roomOpen ? "房间开启" : "房间休眠"}</span>
        <span>Relay {model.connectionStatus.label}</span>
        <span>Host {model.hostStatus?.phase ?? "unpaired"}</span>
        <span>{summary?.rootLabel ?? "未连接项目"}</span>
        <span>{summary?.selectedThreadId ? "任务已选择" : "未选择任务"}</span>
        <span className="desktop-statusbar-spacer" />
        <span>{model.workspaceReadOnly ? "只读" : "可写"}</span>
        <span>同步 {statusTime(summary?.syncedAt)}</span>
      </footer>
    </div>
  );
}
