import {
  Avatar,
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Spinner,
  Tab,
  TabList,
} from "@fluentui/react-components";
import { DismissRegular, KeyRegular } from "@fluentui/react-icons";
import type { AccountProfileResponse, AccountRoom } from "@codex-collab/protocol";
import type { FormEvent } from "react";
import { AccountRoomList } from "../account/AccountRoomList.js";
import type { SetupSubmissionMode } from "../session/invite-session.js";

interface SetupDialogProps {
  open: boolean;
  profile: AccountProfileResponse | null;
  credentialNotice: string | null;
  accountError: string | null;
  accountChecking: boolean;
  supportsPasskeys: boolean;
  initialInviteToken: string | null;
  accountDisplayName: string;
  displayName: string;
  roomName: string;
  joinToken: string;
  setupMode: SetupSubmissionMode;
  recoverySessionId: string;
  recoveryKey: string;
  currentSessionId: string | null;
  restoringRoomId: string | null;
  accountSubmitting: boolean;
  submitting: boolean;
  onCredentialNoticeChange: (value: string | null) => void;
  onAccountDisplayNameChange: (value: string) => void;
  onDisplayNameChange: (value: string) => void;
  onRoomNameChange: (value: string) => void;
  onJoinTokenChange: (value: string) => void;
  onSetupModeChange: (value: SetupSubmissionMode) => void;
  onRecoverySessionIdChange: (value: string) => void;
  onRecoveryKeyChange: (value: string) => void;
  onAuthenticate: (mode: "signin" | "register") => void;
  onActivateRoom: (room: AccountRoom) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

export function SetupDialog({
  open,
  profile,
  credentialNotice,
  accountError,
  accountChecking,
  supportsPasskeys,
  initialInviteToken,
  accountDisplayName,
  displayName,
  roomName,
  joinToken,
  setupMode,
  recoverySessionId,
  recoveryKey,
  currentSessionId,
  restoringRoomId,
  accountSubmitting,
  submitting,
  onCredentialNoticeChange,
  onAccountDisplayNameChange,
  onDisplayNameChange,
  onRoomNameChange,
  onJoinTokenChange,
  onSetupModeChange,
  onRecoverySessionIdChange,
  onRecoveryKeyChange,
  onAuthenticate,
  onActivateRoom,
  onSubmit,
}: SetupDialogProps) {
  return (
    <Dialog open={open}>
      <DialogSurface>
        <form onSubmit={onSubmit}>
          <DialogBody>
            <DialogTitle>{profile ? "选择或创建房间" : "登录 Codex Collab"}</DialogTitle>
            <DialogContent className="setup-fields">
              {credentialNotice ? (
                <MessageBar intent="warning">
                  <MessageBarBody><MessageBarTitle>需要重新连接</MessageBarTitle>{credentialNotice}</MessageBarBody>
                  <Button appearance="transparent" icon={<DismissRegular />} aria-label="关闭会话失效提示" onClick={() => onCredentialNoticeChange(null)} />
                </MessageBar>
              ) : null}
              {accountError ? (
                <MessageBar intent="error">
                  <MessageBarBody><MessageBarTitle>账号操作未完成</MessageBarTitle>{accountError}</MessageBarBody>
                </MessageBar>
              ) : null}
              {accountChecking ? (
                <div className="account-loading" aria-live="polite"><Spinner size="small" label="正在检查账号状态" /></div>
              ) : !profile ? (
                <>
                  <p className="dialog-intro">使用设备通行密钥保存你的房间。以后在其他支持的设备上登录即可继续使用。</p>
                  {!supportsPasskeys ? (
                    <MessageBar intent="warning"><MessageBarBody>通行密钥需要 HTTPS，或从本机 localhost 地址打开。</MessageBarBody></MessageBar>
                  ) : null}
                  {initialInviteToken ? (
                    <MessageBar intent="success"><MessageBarBody>邀请已经读取。登录或创建账号后继续申请加入。</MessageBarBody></MessageBar>
                  ) : null}
                  <Field label="新账号显示名称" required>
                    <Input value={accountDisplayName} maxLength={80} autoComplete="name webauthn" onChange={(_, data) => onAccountDisplayNameChange(data.value)} />
                  </Field>
                </>
              ) : (
                <>
                  <div className="account-summary">
                    <Avatar name={profile.account.displayName} color="colorful" size={36} />
                    <div><strong>{profile.account.displayName}</strong><span>{profile.rooms.length} 个已保存房间</span></div>
                  </div>
                  {!initialInviteToken && profile.rooms.length > 0 ? (
                    <AccountRoomList rooms={profile.rooms} currentSessionId={currentSessionId} restoringRoomId={restoringRoomId} onRestore={onActivateRoom} />
                  ) : null}
                  {!initialInviteToken && profile.rooms.length > 0 ? <div className="dialog-divider"><span>创建或加入其他房间</span></div> : null}
                  {initialInviteToken ? (
                    <>
                      <p className="dialog-intro">你收到了一次性协作邀请。申请后仍需主人明确批准。</p>
                      <Field label="房间内显示名称" required>
                        <Input value={displayName} maxLength={80} autoComplete="name" onChange={(_, data) => onDisplayNameChange(data.value)} />
                      </Field>
                      <MessageBar intent="success"><MessageBarBody>一次性邀请已读取。提交后需要等待主人明确批准。</MessageBarBody></MessageBar>
                    </>
                  ) : (
                    <>
                      <p className="dialog-intro">创建新房间、使用邀请加入，或用房主密钥恢复原房间和历史记录。</p>
                      <TabList
                        selectedValue={setupMode}
                        onTabSelect={(_, data) => onSetupModeChange(data.value as SetupSubmissionMode)}
                        aria-label="连接房间方式"
                      >
                        <Tab value="create">创建房间</Tab>
                        <Tab value="join">邀请加入</Tab>
                        <Tab value="recover">恢复房间</Tab>
                      </TabList>
                      {setupMode === "recover" ? (
                        <>
                          <MessageBar intent="warning"><MessageBarBody>只有房主可以使用恢复密钥。成功后会继续使用原房间。</MessageBarBody></MessageBar>
                          <Field label="房间 ID" required>
                            <Input value={recoverySessionId} autoComplete="off" onChange={(_, data) => onRecoverySessionIdChange(data.value)} />
                          </Field>
                          <Field label="房主密钥" required>
                            <Input type="password" value={recoveryKey} contentBefore={<KeyRegular />} autoComplete="off" placeholder="ccr_..." onChange={(_, data) => onRecoveryKeyChange(data.value)} />
                          </Field>
                        </>
                      ) : (
                        <>
                          <Field label="房间内显示名称" required>
                            <Input value={displayName} maxLength={80} autoComplete="name" onChange={(_, data) => onDisplayNameChange(data.value)} />
                          </Field>
                          {setupMode === "create" ? (
                            <Field label="新房间名称" required><Input value={roomName} maxLength={120} onChange={(_, data) => onRoomNameChange(data.value)} /></Field>
                          ) : (
                            <Field label="邀请令牌" required><Input value={joinToken} contentBefore={<KeyRegular />} placeholder="cci_..." onChange={(_, data) => onJoinTokenChange(data.value)} /></Field>
                          )}
                        </>
                      )}
                    </>
                  )}
                </>
              )}
            </DialogContent>
            <DialogActions>
              {accountChecking ? null : !profile ? (
                <>
                  <Button type="button" appearance="secondary" disabled={!supportsPasskeys || accountSubmitting} onClick={() => onAuthenticate("signin")}>使用通行密钥登录</Button>
                  <Button type="button" appearance="primary" disabled={!supportsPasskeys || !accountDisplayName.trim() || accountSubmitting} onClick={() => onAuthenticate("register")}>创建账号</Button>
                </>
              ) : initialInviteToken || setupMode === "join" ? (
                <Button type="submit" appearance="primary" disabled={!displayName.trim() || !joinToken.trim() || submitting}>申请加入</Button>
              ) : setupMode === "recover" ? (
                <Button type="submit" appearance="primary" disabled={!recoverySessionId.trim() || !recoveryKey.trim() || submitting}>恢复房间</Button>
              ) : (
                <Button type="submit" appearance="primary" disabled={!displayName.trim() || !roomName.trim() || submitting}>创建会话</Button>
              )}
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}
