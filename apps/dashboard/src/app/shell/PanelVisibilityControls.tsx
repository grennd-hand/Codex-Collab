import { Button, ToggleButton } from "@fluentui/react-components";
import {
  ChatRegular,
  FolderOpenRegular,
  PlugConnectedSettingsRegular,
} from "@fluentui/react-icons";

interface PanelVisibilityControlsProps {
  collaborationVisible: boolean;
  filesAvailable: boolean;
  filesVisible: boolean;
  owner: boolean;
  onOpenWorkspace: () => void;
  onToggleCollaboration: () => void;
  onToggleFiles: () => void;
}

export function PanelVisibilityControls({
  collaborationVisible,
  filesAvailable,
  filesVisible,
  owner,
  onOpenWorkspace,
  onToggleCollaboration,
  onToggleFiles,
}: PanelVisibilityControlsProps) {
  return (
    <div
      className="topbar-panel-controls"
      role="group"
      aria-label="工作区面板"
    >
      <ToggleButton
        appearance="subtle"
        checked={collaborationVisible}
        isAccessible
        icon={<ChatRegular />}
        title={collaborationVisible ? "收起协作聊天" : "打开协作聊天"}
        aria-label={collaborationVisible ? "收起协作聊天" : "打开协作聊天"}
        onClick={onToggleCollaboration}
      >
        <span className="panel-control-label">聊天</span>
      </ToggleButton>
      <ToggleButton
        appearance="subtle"
        checked={filesVisible}
        disabled={!filesAvailable}
        isAccessible
        icon={<FolderOpenRegular />}
        title={filesVisible ? "收起项目目录" : "打开项目目录"}
        aria-label={filesVisible ? "收起项目目录" : "打开项目目录"}
        onClick={onToggleFiles}
      >
        <span className="panel-control-label">目录</span>
      </ToggleButton>
      {owner || !filesAvailable ? (
        <Button
          appearance="subtle"
          className="workspace-button"
          icon={<PlugConnectedSettingsRegular />}
          title={filesAvailable ? "切换配对工作区" : "连接工作区"}
          aria-label={filesAvailable ? "切换配对工作区" : "连接工作区"}
          onClick={onOpenWorkspace}
        >
          <span className="workspace-button-label">
            {filesAvailable ? "切换工作区" : "连接工作区"}
          </span>
        </Button>
      ) : null}
    </div>
  );
}
