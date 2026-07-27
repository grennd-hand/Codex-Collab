import {
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
import { CheckmarkCircleRegular, CopyRegular } from "@fluentui/react-icons";
import type { RefObject } from "react";
import { isLoopbackOrigin } from "../session/session-storage.js";

interface InviteDialogProps {
  open: boolean;
  inviteLink: string;
  copied: boolean;
  copyFailed: boolean;
  inviteLinkRef: RefObject<HTMLInputElement | null>;
  onOpenChange: (open: boolean) => void;
  onCopy: () => void;
}

export function InviteDialog({
  open,
  inviteLink,
  copied,
  copyFailed,
  inviteLinkRef,
  onOpenChange,
  onCopy,
}: InviteDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(_, data) => onOpenChange(data.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>邀请一位协作者</DialogTitle>
          <DialogContent className="setup-fields">
            <p className="dialog-intro">链接有效期 60 分钟，仅可使用一次。对方申请加入后仍需你的批准。</p>
            {isLoopbackOrigin() ? (
              <MessageBar intent="warning">
                <MessageBarBody>当前链接仅能在这台电脑打开。邀请其他设备前，请从局域网地址或已部署的 HTTPS Relay 打开控制台。</MessageBarBody>
              </MessageBar>
            ) : null}
            <Field label="一次性邀请链接">
              <Input
                ref={inviteLinkRef}
                value={inviteLink}
                readOnly
                onClick={(event) => event.currentTarget.select()}
                onFocus={(event) => event.currentTarget.select()}
              />
            </Field>
            {copied ? (
              <div className="copy-confirmation" aria-live="polite"><CheckmarkCircleRegular />邀请链接已复制</div>
            ) : null}
            {copyFailed ? (
              <MessageBar intent="warning">
                <MessageBarBody><MessageBarTitle>浏览器阻止了自动复制</MessageBarTitle>链接已经选中，请按 Ctrl+C 复制。</MessageBarBody>
              </MessageBar>
            ) : null}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>关闭</Button>
            <Button appearance="primary" icon={<CopyRegular />} onClick={onCopy}>{copied ? "已复制" : "复制邀请链接"}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
