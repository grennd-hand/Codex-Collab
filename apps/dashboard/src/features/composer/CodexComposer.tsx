import { Button, Spinner, Textarea } from "@fluentui/react-components";
import { AttachRegular, DeleteRegular } from "@fluentui/react-icons";
import type { CodexPromptOptions, Member } from "@codex-collab/protocol";
import type { Dispatch, RefObject, SetStateAction } from "react";
import {
  attachmentSizeLabel,
  type PendingAttachment,
} from "./attachments.js";
import type { CodexExecutionPhase } from "./codex-controls.js";
import { CodexComposerControls } from "./CodexComposerControls.js";

interface CodexComposerProps {
  approved: boolean;
  roomOpen: boolean;
  submitting: boolean;
  memberRole: Member["role"] | null;
  draft: string;
  onDraftChange: (value: string) => void;
  draggingFiles: boolean;
  onDraggingFilesChange: (dragging: boolean) => void;
  preparingAttachments: boolean;
  pendingAttachments: PendingAttachment[];
  setPendingAttachments: Dispatch<SetStateAction<PendingAttachment[]>>;
  onAddAttachments: (files: FileList | File[]) => void;
  attachmentInputRef: RefObject<HTMLInputElement | null>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  dictating: boolean;
  onToggleDictation: () => void;
  codexOptions: CodexPromptOptions;
  setCodexOptions: Dispatch<SetStateAction<CodexPromptOptions>>;
  executionPhase: CodexExecutionPhase;
  primaryStopsCodex: boolean;
  canStopCodex: boolean;
  canSendCodex: boolean;
  onSendPrompt: () => void;
  onStopCodex: () => void;
  onError: (message: string) => void;
}

export function CodexComposer({
  approved,
  roomOpen,
  submitting,
  memberRole,
  draft,
  onDraftChange,
  draggingFiles,
  onDraggingFilesChange,
  preparingAttachments,
  pendingAttachments,
  setPendingAttachments,
  onAddAttachments,
  attachmentInputRef,
  textareaRef,
  dictating,
  onToggleDictation,
  codexOptions,
  setCodexOptions,
  executionPhase,
  primaryStopsCodex,
  canStopCodex,
  canSendCodex,
  onSendPrompt,
  onStopCodex,
  onError,
}: CodexComposerProps) {
  const sendPrimaryAction = () => {
    if (primaryStopsCodex) {
      if (canStopCodex) onStopCodex();
      return;
    }
    if (canSendCodex) onSendPrompt();
  };

  return (
    <form
      className={`composer ${draggingFiles ? "dragging" : ""}`}
      onSubmit={(event) => {
        event.preventDefault();
        sendPrimaryAction();
      }}
      onDragEnter={(event) => {
        event.preventDefault();
        if (approved) onDraggingFilesChange(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          onDraggingFilesChange(false);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDraggingFilesChange(false);
        if (approved) onAddAttachments(event.dataTransfer.files);
      }}
    >
      <input
        ref={attachmentInputRef}
        className="visually-hidden"
        type="file"
        multiple
        disabled={!roomOpen || preparingAttachments}
        tabIndex={-1}
        onChange={(event) => {
          if (event.currentTarget.files) onAddAttachments(event.currentTarget.files);
          event.currentTarget.value = "";
        }}
      />
      <div className="composer-surface">
        <Textarea
          ref={textareaRef}
          value={draft}
          resize="none"
          disabled={!approved || submitting || !roomOpen}
          aria-label="发送给 Codex"
          placeholder={
            !roomOpen
              ? "房间已关闭"
              : approved
                ? "随心输入"
                : "连接并通过批准后即可发送"
          }
          onChange={(_, data) => onDraftChange(data.value)}
          onPaste={(event) => {
            if (event.clipboardData.files.length > 0) {
              event.preventDefault();
              onAddAttachments(event.clipboardData.files);
            }
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              sendPrimaryAction();
            }
          }}
        />
        {preparingAttachments ? (
          <div className="attachment-preparing" role="status">
            <Spinner size="tiny" />
            <span>正在压缩图片…</span>
          </div>
        ) : null}
        {pendingAttachments.length > 0 ? (
          <div className="pending-attachments" aria-label="待发送附件">
            {pendingAttachments.map((attachment) => (
              <span key={attachment.id}>
                <AttachRegular aria-hidden="true" />
                <span title={attachment.file.name}>{attachment.file.name}</span>
                <small>{attachmentSizeLabel(attachment)}</small>
                <Button
                  type="button"
                  appearance="subtle"
                  size="small"
                  icon={<DeleteRegular />}
                  title={`移除 ${attachment.file.name}`}
                  aria-label={`移除 ${attachment.file.name}`}
                  onClick={() =>
                    setPendingAttachments((current) =>
                      current.filter((item) => item.id !== attachment.id),
                    )
                  }
                />
              </span>
            ))}
          </div>
        ) : null}
        <CodexComposerControls
          approved={approved}
          roomOpen={roomOpen}
          submitting={submitting}
          memberRole={memberRole}
          attachmentInputRef={attachmentInputRef}
          preparingAttachments={preparingAttachments}
          pendingAttachments={pendingAttachments}
          setPendingAttachments={setPendingAttachments}
          dictating={dictating}
          onToggleDictation={onToggleDictation}
          codexOptions={codexOptions}
          setCodexOptions={setCodexOptions}
          executionPhase={executionPhase}
          primaryStopsCodex={primaryStopsCodex}
          canStopCodex={canStopCodex}
          canSendCodex={canSendCodex}
          onError={onError}
        />
      </div>
    </form>
  );
}
