import { Button } from "@fluentui/react-components";
import { ArrowSyncRegular } from "@fluentui/react-icons";
import type { DashboardViewModel } from "../../../dashboard/src/app/dashboard-view-model.js";
import { CodexComposer } from "../../../dashboard/src/features/composer/CodexComposer.js";
import { CodexTimeline } from "../../../dashboard/src/features/timeline/CodexTimeline.js";

export function DesktopCodexPane({ model }: { model: DashboardViewModel }) {
  const {
    approved,
    canSendCodex,
    canStopCodex,
    codexTimeline,
    composer,
    conversationInitialLoading,
    executionEntryCount,
    executionPhase,
    hasCodexContent,
    hasRunningExecutionEntry,
    hiddenUnassignedMessageCount,
    identityForMember,
    member,
    messageStreamPinned,
    messageStreamRef,
    onMessageStreamPinnedChange,
    primaryStopsCodex,
    refresh,
    roomOpen,
    session,
    setError,
    showError,
    submission,
    workspaceFiles,
    workspaceHistory,
  } = model;
  const selectedTask = workspaceHistory.summary?.selectedThread;

  return (
    <main className="chat-panel desktop-codex-pane" aria-label="Codex 任务">
      <div className="chat-heading desktop-codex-heading">
        <div>
          <p className="session-id">
            {selectedTask ? "当前 Codex 任务" : session?.name ?? "共享任务"}
          </p>
          <h2>
            {selectedTask?.name || selectedTask?.preview || "请选择 Codex 任务"}
          </h2>
        </div>
        {approved ? (
          <Button
            appearance="subtle"
            icon={<ArrowSyncRegular />}
            title="刷新当前任务"
            aria-label="刷新当前任务"
            onClick={() => void refresh()}
          />
        ) : null}
      </div>
      <CodexTimeline
        streamRef={messageStreamRef}
        history={workspaceHistory.historyWindow}
        initialLoading={conversationInitialLoading}
        hiddenUnassignedMessageCount={hiddenUnassignedMessageCount}
        hasContent={hasCodexContent}
        member={member}
        items={codexTimeline}
        executionPhase={executionPhase}
        executionEntryCount={executionEntryCount}
        hasRunningExecutionEntry={hasRunningExecutionEntry}
        pinned={messageStreamPinned}
        identityForMember={identityForMember}
        onPinnedChange={onMessageStreamPinnedChange}
        onLoadOlder={() => void workspaceHistory.loadOlder()}
        onRetry={() => void workspaceHistory.refresh(true).catch(showError)}
        onOpenFile={workspaceFiles.openFromExecution}
      />
      <CodexComposer
        approved={approved}
        roomOpen={roomOpen}
        submitting={submission.submitting}
        memberRole={member?.role ?? null}
        draft={composer.draft}
        onDraftChange={composer.setDraft}
        draggingFiles={composer.draggingFiles}
        onDraggingFilesChange={composer.setDraggingFiles}
        preparingAttachments={composer.preparingCodexAttachments}
        pendingAttachments={composer.pendingAttachments}
        setPendingAttachments={composer.setPendingAttachments}
        onAddAttachments={(files) => void composer.addAttachments(files)}
        attachmentInputRef={composer.attachmentInputRef}
        textareaRef={composer.codexTextareaRef}
        dictating={composer.dictating}
        onToggleDictation={composer.toggleDictation}
        codexOptions={composer.codexOptions}
        setCodexOptions={composer.setCodexOptions}
        executionPhase={executionPhase}
        primaryStopsCodex={primaryStopsCodex}
        canStopCodex={canStopCodex}
        canSendCodex={canSendCodex}
        onSendPrompt={() => void submission.sendMessage("codex_prompt")}
        onStopCodex={() => void submission.sendMessage("codex_stop")}
        onError={setError}
      />
    </main>
  );
}
