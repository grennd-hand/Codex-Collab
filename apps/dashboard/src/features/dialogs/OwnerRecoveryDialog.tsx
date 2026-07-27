import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Textarea,
} from "@fluentui/react-components";
import {
  CheckmarkCircleRegular,
  CopyRegular,
} from "@fluentui/react-icons";
import type { RefObject } from "react";
import { recoveryBundleText } from "../session/room-recovery.js";

interface OwnerRecoveryDialogProps {
  sessionId: string;
  recoveryKey: string;
  copied: boolean;
  bundleRef: RefObject<HTMLTextAreaElement | null>;
  onCopy: () => void;
  onSaved: () => void;
}

export function OwnerRecoveryDialog({
  sessionId,
  recoveryKey,
  copied,
  bundleRef,
  onCopy,
  onSaved,
}: OwnerRecoveryDialogProps) {
  return (
    <Dialog open={Boolean(recoveryKey)} modalType="alert">
      <DialogSurface>
        <DialogBody>
          <DialogTitle>保存房主密钥</DialogTitle>
          <DialogContent className="setup-fields">
            <MessageBar intent="warning">
              <MessageBarBody>
                <MessageBarTitle>该密钥只显示一次</MessageBarTitle>
                请把房间 ID 和房主密钥保存在安全位置。服务器只保存哈希，无法替你找回。
              </MessageBarBody>
            </MessageBar>
            <Field label="房间恢复凭据">
              <Textarea
                ref={bundleRef}
                className="recovery-bundle"
                value={recoveryBundleText(sessionId, recoveryKey)}
                readOnly
                resize="vertical"
                onClick={(event) => event.currentTarget.select()}
                onFocus={(event) => event.currentTarget.select()}
              />
            </Field>
            <p className="dialog-intro">以后清除浏览器数据或更换设备时，选择“恢复房间”并输入这两项。</p>
            {copied ? (
              <div className="copy-confirmation" aria-live="polite">
                <CheckmarkCircleRegular />房间恢复凭据已复制
              </div>
            ) : null}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" icon={<CopyRegular />} onClick={onCopy}>复制凭据</Button>
            <Button appearance="primary" onClick={onSaved}>我已安全保存</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
