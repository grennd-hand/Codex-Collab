import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
} from "@fluentui/react-components";
import { DismissRegular } from "@fluentui/react-icons";
import type { FormEvent } from "react";
import type { SetupSubmissionMode } from "../session/invite-session.js";
import { RoomAccessFields, RoomSubmitButton } from "./RoomAccessFields.js";

interface SetupDialogProps {
  open: boolean;
  credentialNotice: string | null;
  initialInviteToken: string | null;
  displayName: string;
  roomName: string;
  joinToken: string;
  setupMode: SetupSubmissionMode;
  recoverySessionId: string;
  recoveryKey: string;
  submitting: boolean;
  onCredentialNoticeChange: (value: string | null) => void;
  onDisplayNameChange: (value: string) => void;
  onRoomNameChange: (value: string) => void;
  onJoinTokenChange: (value: string) => void;
  onSetupModeChange: (value: SetupSubmissionMode) => void;
  onRecoverySessionIdChange: (value: string) => void;
  onRecoveryKeyChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

export function SetupDialog({
  open,
  credentialNotice,
  initialInviteToken,
  displayName,
  roomName,
  joinToken,
  setupMode,
  recoverySessionId,
  recoveryKey,
  submitting,
  onCredentialNoticeChange,
  onDisplayNameChange,
  onRoomNameChange,
  onJoinTokenChange,
  onSetupModeChange,
  onRecoverySessionIdChange,
  onRecoveryKeyChange,
  onSubmit,
}: SetupDialogProps) {
  return (
    <Dialog open={open}>
      <DialogSurface className="setup-dialog-surface">
        <form onSubmit={onSubmit}>
          <DialogBody>
            <DialogTitle>连接协作房间</DialogTitle>
            <DialogContent className="setup-fields setup-dialog-content">
              {credentialNotice ? (
                <MessageBar intent="warning">
                  <MessageBarBody><MessageBarTitle>需要重新连接</MessageBarTitle>{credentialNotice}</MessageBarBody>
                  <Button appearance="transparent" icon={<DismissRegular />} aria-label="关闭会话失效提示" onClick={() => onCredentialNoticeChange(null)} />
                </MessageBar>
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
