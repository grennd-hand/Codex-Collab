import {
  Badge,
  Button,
  Select,
  Switch,
} from "@fluentui/react-components";
import {
  ChatMultipleRegular,
  HistoryRegular,
  PersonAddRegular,
  SignOutRegular,
  WeatherMoonRegular,
  WeatherSunnyRegular,
} from "@fluentui/react-icons";
import type {
  Member,
  WorkspaceSummary,
} from "@codex-collab/protocol";
import { HeaderIdentity } from "./HeaderIdentity.js";
import { PanelVisibilityControls } from "./PanelVisibilityControls.js";
import type { ThemeMode } from "./theme.js";
import type { HostStatusV1 } from "../../shared/runtime/index.js";
import { HostStatusBadge } from "./HostStatusBadge.js";

export interface AppHeaderProps {
  member: Member | null;
  approved: boolean;
  workspaceSummary: WorkspaceSummary | null;
  workspaceLoading: boolean;
  roomOpen: boolean;
  roomStatusUpdating: boolean;
  themeMode: ThemeMode;
  hasSession: boolean;
  connectionStatus: {
    label: string;
    color: "success" | "warning" | "danger" | "informative";
  };
  hostStatus: HostStatusV1 | null;
  collaborationPanelVisible: boolean;
  directoryPanelVisible: boolean;
  onSelectThread: (threadId: string) => void;
  onToggleCollaborationPanel: () => void;
  onToggleDirectoryPanel: () => void;
  onUpdateRoomStatus: (open: boolean) => void;
  onOpenWorkspace: () => void;
  onCreateInvite: () => void;
  onToggleTheme: () => void;
  onResetSession: () => void;
}

export function AppHeader({
  member,
  approved,
  workspaceSummary,
  workspaceLoading,
  roomOpen,
  roomStatusUpdating,
  themeMode,
  hasSession,
  connectionStatus,
  hostStatus,
  collaborationPanelVisible,
  directoryPanelVisible,
  onSelectThread,
  onToggleCollaborationPanel,
  onToggleDirectoryPanel,
  onUpdateRoomStatus,
  onOpenWorkspace,
  onCreateInvite,
  onToggleTheme,
  onResetSession,
}: AppHeaderProps) {
  const owner = member?.role === "owner";

  return (
    <header className="topbar">
      <div className="brand-lockup">
        <div className="brand-mark" aria-hidden="true">
          <ChatMultipleRegular />
        </div>
        <div>
          <div className="product-context">共享 Codex 工作区</div>
          <h1>Codex Collab</h1>
        </div>
      </div>

      {approved ? (
        <PanelVisibilityControls
          collaborationVisible={collaborationPanelVisible}
          filesAvailable={Boolean(workspaceSummary?.hostConnected)}
          filesVisible={directoryPanelVisible}
          owner={owner}
          onOpenWorkspace={onOpenWorkspace}
          onToggleCollaboration={onToggleCollaborationPanel}
          onToggleFiles={onToggleDirectoryPanel}
        />
      ) : null}

      {owner && approved && workspaceSummary?.hostConnected ? (
        <div className="topbar-thread-control">
          <HistoryRegular aria-hidden="true" />
          <div>
            <label htmlFor="topbar-codex-thread">聊天记录</label>
            <Select
              id="topbar-codex-thread"
              aria-label="聊天记录"
              value={workspaceSummary.selectedThreadId ?? ""}
              disabled={workspaceLoading || workspaceSummary.threads.length === 0}
              onChange={(_, data) => onSelectThread(data.value)}
            >
              <option value="">
                {workspaceSummary.threads.length === 0
                  ? "暂无 Codex 记录"
                  : "请选择 Codex 任务"}
              </option>
              {workspaceSummary.threads.map((thread) => (
                <option value={thread.id} key={thread.id}>
                  {thread.name || thread.preview || thread.id}
                </option>
              ))}
            </Select>
          </div>
        </div>
      ) : null}

      <div className="topbar-actions">
        {owner && approved ? (
          <Switch
            className="room-switch"
            checked={roomOpen}
            disabled={roomStatusUpdating}
            label={roomOpen ? "房间已开启" : "房间已关闭"}
            aria-label={roomOpen ? "关闭房间" : "开启房间"}
            onChange={(_, data) => onUpdateRoomStatus(data.checked)}
          />
        ) : null}
        {owner && approved ? (
          <Button
            appearance="secondary"
            icon={<PersonAddRegular />}
            className="invite-button"
            disabled={!roomOpen || roomStatusUpdating}
            onClick={onCreateInvite}
          >
            创建邀请
          </Button>
        ) : null}
        <HeaderIdentity member={member} />
        <Button
          appearance="subtle"
          className="stable-icon-button"
          icon={
            themeMode === "dark" ? (
              <WeatherSunnyRegular />
            ) : (
              <WeatherMoonRegular />
            )
          }
          title="切换明暗主题"
          aria-label="切换明暗主题"
          onClick={onToggleTheme}
        />
        {hasSession ? (
          <Button
            appearance="subtle"
            icon={<SignOutRegular />}
            title="离开本机会话"
            aria-label="离开本机会话"
            onClick={onResetSession}
          />
        ) : null}
        <HostStatusBadge status={hostStatus} />
        <Badge
          appearance="tint"
          aria-label={connectionStatus.label}
          className="connection-badge"
          color={connectionStatus.color}
          size="large"
        >
          {connectionStatus.label}
        </Badge>
      </div>
    </header>
  );
}
