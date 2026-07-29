import { Button, ToggleButton } from "@fluentui/react-components";
import {
  FolderOpenRegular,
  PeopleRegular,
  PulseRegular,
  SettingsRegular,
} from "@fluentui/react-icons";

export type DesktopSidebarMode = "collaboration" | "activity";

interface DesktopActivityRailProps {
  activeSidebar: DesktopSidebarMode | null;
  filesVisible: boolean;
  pendingMemberCount: number;
  workspaceAvailable: boolean;
  workspaceConfigurable: boolean;
  onSelectSidebar: (mode: DesktopSidebarMode) => void;
  onShowFiles: () => void;
  onOpenWorkspace: () => void;
}

export function DesktopActivityRail({
  activeSidebar,
  filesVisible,
  pendingMemberCount,
  workspaceAvailable,
  workspaceConfigurable,
  onSelectSidebar,
  onShowFiles,
  onOpenWorkspace,
}: DesktopActivityRailProps) {
  return (
    <nav className="desktop-activity-rail" aria-label="桌面工作区导航">
      <div className="desktop-activity-rail-primary">
        <ToggleButton
          appearance="subtle"
          checked={activeSidebar === "collaboration"}
          isAccessible
          icon={<PeopleRegular />}
          title="协作成员与聊天"
          aria-label="协作成员与聊天"
          onClick={() => onSelectSidebar("collaboration")}
        />
        {pendingMemberCount > 0 ? (
          <span
            className="desktop-rail-count"
            aria-label={`${pendingMemberCount} 位成员等待批准`}
          >
            {pendingMemberCount > 9 ? "9+" : pendingMemberCount}
          </span>
        ) : null}
        <ToggleButton
          appearance="subtle"
          checked={filesVisible}
          disabled={!workspaceAvailable}
          isAccessible
          icon={<FolderOpenRegular />}
          title="显示项目 IDE"
          aria-label="显示项目 IDE"
          onClick={onShowFiles}
        />
        <ToggleButton
          appearance="subtle"
          checked={activeSidebar === "activity"}
          isAccessible
          icon={<PulseRegular />}
          title="最近活动"
          aria-label="最近活动"
          onClick={() => onSelectSidebar("activity")}
        />
      </div>
      <Button
        appearance="subtle"
        icon={<SettingsRegular />}
        title={workspaceAvailable ? "切换工作区" : "连接工作区"}
        aria-label={workspaceAvailable ? "切换工作区" : "连接工作区"}
        disabled={!workspaceConfigurable}
        onClick={onOpenWorkspace}
      />
    </nav>
  );
}
