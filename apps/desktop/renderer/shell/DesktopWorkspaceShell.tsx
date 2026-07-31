import { useState, type ReactNode } from "react";
import type { DashboardViewModel } from "../../../dashboard/src/app/dashboard-view-model.js";
import { ErrorBanner } from "../../../dashboard/src/app/shell/ErrorBanner.js";
import { ActivityPanel } from "../../../dashboard/src/features/activity/ActivityPanel.js";
import { useIdeWorkspaceRelease } from "../../../dashboard/src/ide/state/ide-workspace-lifecycle.js";
import {
  taskUiScope,
  workspaceDataScope,
} from "../../../dashboard/src/ide/state/workspace-file-cache.js";
import { useWorkspacePanelVisibility } from "../../../dashboard/src/layout/workspace/useWorkspacePanelVisibility.js";
import {
  DesktopPanelStrip,
  type DesktopPanelDefinition,
} from "../layout/DesktopPanelStrip.js";
import {
  desktopPanelStorageKey,
  type DesktopPanelId,
} from "../layout/desktop-panel-arrangement.js";
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

  const workspacePanels: Partial<
    Record<DesktopPanelId, DesktopPanelDefinition>
  > = {
    codex: {
      label: "Codex 任务",
      content: <DesktopCodexPane model={model} />,
    },
  };
  if (sidebar) {
    workspacePanels.sidebar = {
      label: visibleSidebar === "activity" ? "任务活动" : "协作成员",
      content: sidebar,
    };
  }
  if (filesVisible) {
    workspacePanels.files = {
      label: "项目文件",
      content: (
        <DesktopFilesPane
          dataScope={dataScope}
          model={model}
          taskScope={taskScope}
        />
      ),
    };
  }

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
          <DesktopPanelStrip
            key={taskScope}
            editorExpanded={model.workspaceFiles.editorExpanded}
            panels={workspacePanels}
            storageKey={desktopPanelStorageKey(taskScope)}
          />
        </section>
      </div>
      <footer className="desktop-statusbar" aria-label="工作台状态">
        <div className="desktop-statusbar-live">
          <span>{model.roomOpen ? "房间开启" : "房间休眠"}</span>
          <span>Relay {model.connectionStatus.label}</span>
          <span>Host {model.hostStatus?.phase ?? "unpaired"}</span>
        </div>
        <div className="desktop-statusbar-context">
          <span title={summary?.rootLabel ?? "未连接项目"}>
            {summary?.rootLabel ?? "未连接项目"}
          </span>
          <span>{summary?.selectedThreadId ? "任务已选择" : "未选择任务"}</span>
        </div>
        <div className="desktop-statusbar-trailing">
          <span>{model.workspaceReadOnly ? "只读" : "可写"}</span>
          <span>同步 {statusTime(summary?.syncedAt)}</span>
        </div>
      </footer>
    </div>
  );
}
