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
} from "@fluentui/react-components";
import { DismissRegular } from "@fluentui/react-icons";
import type { AccountProfileResponse, AccountRoom } from "@codex-collab/protocol";
import type { FormEvent } from "react";
import { AccountRoomList } from "../account/AccountRoomList.js";
import type { SetupSubmissionMode } from "../session/invite-session.js";
import { RoomAccessFields, RoomSubmitButton } from "./RoomAccessFields.js";

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

function OptionalAccountAccess(props: Pick<SetupDialogProps, "accountChecking" | "supportsPasskeys" | "accountDisplayName" | "accountSubmitting" | "onAccountDisplayNameChange" | "onAuthenticate">) {
  return (
    <>
      <div className="dialog-divider"><span>可选账号</span></div>
      {props.accountChecking ? (
        <div className="account-loading account-loading-compact" aria-live="polite"><Spinner size="tiny" label="正在检查已保存的账号" /></div>
      ) : (
        <>
          <p className="dialog-intro">房主密钥已经可以重复恢复房间。通行密钥账号仅用于自动保存房间列表。</p>
          {!props.supportsPasskeys ? (
            <MessageBar intent="warning"><MessageBarBody>当前页面不能使用通行密钥，但不影响创建、加入或恢复房间。</MessageBarBody></MessageBar>
          ) : null}
          <Field label="账号显示名称">
            <Input value={props.accountDisplayName} maxLength={80} autoComplete="name webauthn" onChange={(_, data) => props.onAccountDisplayNameChange(data.value)} />
          </Field>
          <div className="optional-account-actions">
            <Button type="button" appearance="subtle" disabled={!props.supportsPasskeys || props.accountSubmitting} onClick={() => props.onAuthenticate("signin")}>登录已保存账号</Button>
            <Button type="button" appearance="secondary" disabled={!props.supportsPasskeys || !props.accountDisplayName.trim() || props.accountSubmitting} onClick={() => props.onAuthenticate("register")}>创建可选账号</Button>
          </div>
        </>
      )}
    </>
  );
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
            <DialogTitle>连接协作房间</DialogTitle>
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
              {profile ? (
                <>
                  <div className="account-summary">
                    <Avatar name={profile.account.displayName} color="colorful" size={36} />
                    <div><strong>{profile.account.displayName}</strong><span>{profile.rooms.length} 个已保存房间</span></div>
                  </div>
                  {!initialInviteToken && profile.rooms.length > 0 ? (
                    <AccountRoomList rooms={profile.rooms} currentSessionId={currentSessionId} restoringRoomId={restoringRoomId} onRestore={onActivateRoom} />
                  ) : null}
                  {!initialInviteToken && profile.rooms.length > 0 ? <div className="dialog-divider"><span>连接其他房间</span></div> : null}
                </>
              ) : null}
              <RoomAccessFields
                initialInviteToken={initialInviteToken}
                displayName={displayName}
                roomName={roomName}
                joinToken={joinToken}
                setupMode={setupMode}
                recoverySessionId={recoverySessionId}
                recoveryKey={recoveryKey}
                onDisplayNameChange={onDisplayNameChange}
                onRoomNameChange={onRoomNameChange}
                onJoinTokenChange={onJoinTokenChange}
                onSetupModeChange={onSetupModeChange}
                onRecoverySessionIdChange={onRecoverySessionIdChange}
                onRecoveryKeyChange={onRecoveryKeyChange}
              />
              {!profile ? (
                <OptionalAccountAccess
                  accountChecking={accountChecking}
                  supportsPasskeys={supportsPasskeys}
                  accountDisplayName={accountDisplayName}
                  accountSubmitting={accountSubmitting}
                  onAccountDisplayNameChange={onAccountDisplayNameChange}
                  onAuthenticate={onAuthenticate}
                />
              ) : null}
            </DialogContent>
            <DialogActions>
              <RoomSubmitButton initialInviteToken={initialInviteToken} displayName={displayName} roomName={roomName} joinToken={joinToken} setupMode={setupMode} recoverySessionId={recoverySessionId} recoveryKey={recoveryKey} submitting={submitting} />
            </DialogActions>
          </DialogBody>
        </form>
      </DialogSurface>
    </Dialog>
  );
}
