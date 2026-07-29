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
  SettingsRegular,
  SignOutRegular,
  WeatherMoonRegular,
  WeatherSunnyRegular,
} from "@fluentui/react-icons";
import type { DashboardViewModel } from "../../../dashboard/src/app/dashboard-view-model.js";
import { HeaderIdentity } from "../../../dashboard/src/app/shell/HeaderIdentity.js";
import { HostStatusBadge } from "../../../dashboard/src/app/shell/HostStatusBadge.js";

interface DesktopCommandBarProps {
  model: DashboardViewModel;
}

export function DesktopCommandBar({ model }: DesktopCommandBarProps) {
  const {
    approved,
    connectionStatus,
    hostStatus,
    invite,
    member,
    resetSession,
    roomOpen,
    session,
    setThemeMode,
    themeMode,
    workspaceConnection,
    workspaceHistory,
  } = model;
  const workspaceSummary = workspaceHistory.summary;
  const owner = member?.role === "owner";

  return (
    <header className="desktop-commandbar">
      <div className="desktop-brand" aria-label="Codex Collab 主人工作台">
        <ChatMultipleRegular aria-hidden="true" />
        <strong>Codex Collab</strong>
        <span>主人端</span>
      </div>

      <div className="desktop-commandbar-center">
        {owner && approved && workspaceSummary?.hostConnected ? (
          <div className="desktop-thread-picker">
            <HistoryRegular aria-hidden="true" />
            <label htmlFor="desktop-codex-thread">Codex 任务</label>
            <Select
              id="desktop-codex-thread"
              aria-label="选择 Codex 任务"
              value={workspaceSummary.selectedThreadId ?? ""}
              disabled={
                workspaceConnection.loading || workspaceSummary.threads.length === 0
              }
              onChange={(_, data) =>
                void workspaceConnection.selectThread(data.value)
              }
            >
              <option value="">
                {workspaceSummary.threads.length === 0
                  ? "暂无任务"
                  : "选择任务"}
              </option>
              {workspaceSummary.threads.map((thread) => (
                <option value={thread.id} key={thread.id}>
                  {thread.name || thread.preview || thread.id}
                </option>
              ))}
            </Select>
          </div>
        ) : (
          <div className="desktop-thread-placeholder">
            {approved ? "连接工作区后选择 Codex 任务" : "等待会话批准"}
          </div>
        )}
      </div>

      <div className="desktop-commandbar-actions">
        {owner && approved ? (
          <Switch
            checked={roomOpen}
            disabled={invite.roomStatusUpdating}
            label={roomOpen ? "房间开启" : "房间关闭"}
            aria-label={roomOpen ? "关闭房间" : "开启房间"}
            onChange={(_, data) => void invite.updateRoomStatus(data.checked)}
          />
        ) : null}
        {owner && approved ? (
          <Button
            appearance="subtle"
            icon={<PersonAddRegular />}
            disabled={!roomOpen || invite.roomStatusUpdating}
            onClick={() => void invite.create()}
          >
            邀请
          </Button>
        ) : null}
        {approved && (owner || !workspaceSummary?.hostConnected) ? (
          <Button
            appearance="subtle"
            icon={<SettingsRegular />}
            title={workspaceSummary?.hostConnected ? "切换工作区" : "连接工作区"}
            aria-label={
              workspaceSummary?.hostConnected ? "切换工作区" : "连接工作区"
            }
            onClick={() => void workspaceConnection.openDialog()}
          />
        ) : null}
        <HeaderIdentity member={member} />
        <Button
          appearance="subtle"
          icon={
            themeMode === "dark" ? (
              <WeatherSunnyRegular />
            ) : (
              <WeatherMoonRegular />
            )
          }
          title="切换明暗主题"
          aria-label="切换明暗主题"
          onClick={() =>
            setThemeMode((current) => (current === "dark" ? "light" : "dark"))
          }
        />
        {session ? (
          <Button
            appearance="subtle"
            icon={<SignOutRegular />}
            title="离开本机会话"
            aria-label="离开本机会话"
            onClick={resetSession}
          />
        ) : null}
        <HostStatusBadge status={hostStatus} />
        <Badge
          appearance="tint"
          color={connectionStatus.color}
          aria-label={connectionStatus.label}
          className="desktop-connection-badge"
        >
          {connectionStatus.label}
        </Badge>
      </div>
    </header>
  );
}
