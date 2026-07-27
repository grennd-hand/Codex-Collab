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
} from "@fluentui/react-components";
import { SignOutRegular } from "@fluentui/react-icons";
import type { AccountProfileResponse, AccountRoom } from "@codex-collab/protocol";
import { AccountRoomList } from "../account/AccountRoomList.js";

interface AccountDialogProps {
  open: boolean;
  profile: AccountProfileResponse | null;
  error: string | null;
  supportsPasskeys: boolean;
  accountDisplayName: string;
  currentSessionId: string | null;
  restoringRoomId: string | null;
  submitting: boolean;
  onOpenChange: (open: boolean) => void;
  onAccountDisplayNameChange: (value: string) => void;
  onActivateRoom: (room: AccountRoom) => void;
  onAuthenticate: (mode: "signin" | "register") => void;
  onSignOut: () => void;
}

export function AccountDialog({
  open,
  profile,
  error,
  supportsPasskeys,
  accountDisplayName,
  currentSessionId,
  restoringRoomId,
  submitting,
  onOpenChange,
  onAccountDisplayNameChange,
  onActivateRoom,
  onAuthenticate,
  onSignOut,
}: AccountDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(_, data) => onOpenChange(data.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{profile ? "我的房间" : "账号登录"}</DialogTitle>
          <DialogContent className="setup-fields">
            {error ? (
              <MessageBar intent="error">
                <MessageBarBody><MessageBarTitle>账号操作未完成</MessageBarTitle>{error}</MessageBarBody>
              </MessageBar>
            ) : null}
            {profile ? (
              <>
                <div className="account-summary">
                  <Avatar name={profile.account.displayName} color="colorful" size={40} />
                  <div><strong>{profile.account.displayName}</strong><span>通行密钥账号</span></div>
                </div>
                {profile.rooms.length > 0 ? (
                  <AccountRoomList rooms={profile.rooms} currentSessionId={currentSessionId} restoringRoomId={restoringRoomId} onRestore={onActivateRoom} />
                ) : (
                  <div className="account-empty">创建房间或通过邀请加入后，这里会保存你的房间。</div>
                )}
              </>
            ) : (
              <>
                <p className="dialog-intro">登录后可以从其他支持通行密钥的设备重新进入自己的房间。</p>
                {!supportsPasskeys ? (
                  <MessageBar intent="warning"><MessageBarBody>通行密钥需要 HTTPS，或从本机 localhost 地址打开。</MessageBarBody></MessageBar>
                ) : null}
                <Field label="新账号显示名称" required>
                  <Input value={accountDisplayName} maxLength={80} autoComplete="name webauthn" onChange={(_, data) => onAccountDisplayNameChange(data.value)} />
                </Field>
              </>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>关闭</Button>
            {profile ? (
              <Button appearance="secondary" icon={<SignOutRegular />} disabled={submitting} onClick={onSignOut}>退出账号</Button>
            ) : (
              <>
                <Button appearance="secondary" disabled={!supportsPasskeys || submitting} onClick={() => onAuthenticate("signin")}>使用通行密钥登录</Button>
                <Button appearance="primary" disabled={!supportsPasskeys || !accountDisplayName.trim() || submitting} onClick={() => onAuthenticate("register")}>创建账号</Button>
              </>
            )}
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
