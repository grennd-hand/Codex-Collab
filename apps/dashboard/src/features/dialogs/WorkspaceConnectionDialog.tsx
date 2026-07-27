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
  Skeleton,
  SkeletonItem,
} from "@fluentui/react-components";
import { CopyRegular } from "@fluentui/react-icons";
import type { Member } from "@codex-collab/protocol";
import type { RefObject } from "react";

interface WorkspaceConnectionDialogProps {
  open: boolean;
  memberRole: Member["role"] | null;
  loading: boolean;
  hasSummary: boolean;
  pairingToken: string | null;
  pairingExpiresAt: string;
  pairingCopied: boolean;
  pairingTokenRef: RefObject<HTMLInputElement | null>;
  onOpenChange: (open: boolean) => void;
  onCreatePairing: () => void;
  onCopyPairing: () => void;
}

export function WorkspaceConnectionDialog({
  open,
  memberRole,
  loading,
  hasSummary,
  pairingToken,
  pairingExpiresAt,
  pairingCopied,
  pairingTokenRef,
  onOpenChange,
  onCreatePairing,
  onCopyPairing,
}: WorkspaceConnectionDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(_, data) => onOpenChange(data.open)}>
      <DialogSurface className="workspace-dialog-surface">
        <DialogBody>
          <DialogTitle>连接 Codex 工作区</DialogTitle>
          <DialogContent className="workspace-dialog-content">
            <p className="dialog-intro">
              文件只从房主明确授权的绝对项目根目录读取。
              .codex 配置目录始终作为单独的只读共享范围。
            </p>
            {loading && !hasSummary ? (
              <div className="workspace-dialog-loading">
                <Skeleton><SkeletonItem /><SkeletonItem /></Skeleton>
              </div>
            ) : null}
            <section className="pairing-panel">
              <div className="workspace-section-heading">
                <div><span>主机连接</span><h3>连接房主的本机 Codex</h3></div>
                {memberRole === "owner" ? (
                  <Button appearance="primary" disabled={loading} onClick={onCreatePairing}>
                    生成一次性配对码
                  </Button>
                ) : null}
              </div>
              {memberRole !== "owner" ? (
                <MessageBar intent="info">
                  <MessageBarBody>等待房主连接本机 Codex 工作区。</MessageBarBody>
                </MessageBar>
              ) : null}
              {pairingToken ? (
                <div className="pairing-instructions">
                  <Field label="一次性配对码">
                    <Input
                      ref={pairingTokenRef}
                      value={pairingToken}
                      readOnly
                      onClick={(event) => event.currentTarget.select()}
                      onFocus={(event) => event.currentTarget.select()}
                      contentAfter={
                        <Button appearance="transparent" icon={<CopyRegular />} aria-label="复制配对码" onClick={onCopyPairing} />
                      }
                    />
                  </Field>
                  <p>
                    回到房主的 Codex 对话，让 Codex 使用
                    <strong> collab_pair_host </strong>
                    认领此码，明确传入 projectRoot；如需配置文件，再单独传入
                    codexConfigRoot（例如用户目录下的 .codex 绝对路径）。
                  </p>
                  <span>
                    {pairingCopied ? "配对码已复制 · " : ""}
                    有效至 {new Date(pairingExpiresAt).toLocaleTimeString("zh-CN")}
                  </span>
                </div>
              ) : null}
            </section>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => onOpenChange(false)}>关闭</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
