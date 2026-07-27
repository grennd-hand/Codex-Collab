import {
  Badge,
  Button,
  Select,
  Switch,
} from "@fluentui/react-components";
import {
  ChatMultipleRegular,
  FolderOpenRegular,
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
import type { ThemeMode } from "./theme.js";

export interface AppHeaderProps {
  member: Member | null;
  approved: boolean;
  workspaceSummary: WorkspaceSummary | null;
  workspaceLoading: boolean;
  roomOpen: boolean;
  roomStatusUpdating: boolean;
  accountDisplayName: string | null;
  themeMode: ThemeMode;
  hasSession: boolean;
  connectionStatus: {
    label: string;
    color: "success" | "warning" | "danger" | "informative";
  };
  onSelectThread: (threadId: string) => void;
  onUpdateRoomStatus: (open: boolean) => void;
  onOpenWorkspace: () => void;
  onCreateInvite: () => void;
  onOpenAccount: () => void;
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
  accountDisplayName,
  themeMode,
  hasSession,
  connectionStatus,
  onSelectThread,
  onUpdateRoomStatus,
  onOpenWorkspace,
  onCreateInvite,
  onOpenAccount,
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
        {approved && !workspaceSummary?.hostConnected ? (
          <Button
            appearance="secondary"
            icon={<FolderOpenRegular />}
            className="workspace-button"
            aria-label="连接工作区"
            onClick={onOpenWorkspace}
          >
            <span className="workspace-button-label">连接工作区</span>
          </Button>
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
        <HeaderIdentity
          member={member}
          accountDisplayName={accountDisplayName}
          onOpenAccount={onOpenAccount}
        />
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
