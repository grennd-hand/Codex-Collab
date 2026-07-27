import { Button, Skeleton, SkeletonItem } from "@fluentui/react-components";
import { ArrowSyncRegular } from "@fluentui/react-icons";
import { lazy, Suspense } from "react";
import type { DashboardViewModel } from "./dashboard-view-model.js";
import { AppHeader } from "./shell/AppHeader.js";
import { ErrorBanner } from "./shell/ErrorBanner.js";
import { ActivityPanel } from "../features/activity/ActivityPanel.js";
import { CollaborationPanel } from "../features/collaboration/CollaborationPanel.js";
import { CodexComposer } from "../features/composer/CodexComposer.js";
import { CodexTimeline } from "../features/timeline/CodexTimeline.js";
import {
  useWorkspacePanelVisibility,
  WorkspacePanelLayout,
} from "../layout/index.js";

const IdeWorkspace = lazy(() => import("../ide/IdeWorkspace.js"));

export function DashboardWorkspaceView({
  model,
}: {
  model: DashboardViewModel;
}) {
  const {
    activities,
    approved,
    canSendChat,
    canSendCodex,
    canStopCodex,
    chatMessages,
    chatStreamRef,
    codexTimeline,
    collaboration,
    composer,
    connectionStatus,
    conversationInitialLoading,
    error,
    executionEntryCount,
    executionPhase,
    hasCodexContent,
    hasRunningExecutionEntry,
    hiddenUnassignedMessageCount,
    identityForMember,
    invite,
    loading,
    member,
    members,
    membersExpanded,
    messageStreamPinned,
    messageStreamRef,
    onMessageStreamPinnedChange,
    owner,
    pendingMemberCount,
    primaryStopsCodex,
    refresh,
    resetSession,
    roomOpen,
    session,
    setError,
    setMembersExpanded,
    setThemeMode,
    showError,
    submission,
    themeMode,
    token,
    workspaceConnected,
    workspaceConnection,
    workspaceFileChanges,
    workspaceFiles,
    workspaceHistory,
    workspaceReadOnly,
  } = model;
  const workspaceSummary = workspaceHistory.summary;
  const panelStorageScope = `${session?.id ?? "anonymous"}:${
    workspaceSummary?.selectedThreadId ?? "unselected"
  }`;
  const panelVisibility = useWorkspacePanelVisibility({
    editorExpanded: workspaceFiles.editorExpanded,
    scope: panelStorageScope,
    setEditorExpanded: workspaceFiles.setEditorExpanded,
    workspaceConnected,
  });

  return (
    <>
      <AppHeader
        member={member}
        approved={approved}
        workspaceSummary={workspaceSummary}
        workspaceLoading={workspaceConnection.loading}
        roomOpen={roomOpen}
        roomStatusUpdating={invite.roomStatusUpdating}
        themeMode={themeMode}
        hasSession={Boolean(session)}
        connectionStatus={connectionStatus}
        collaborationPanelVisible={panelVisibility.collaborationVisible}
        directoryPanelVisible={panelVisibility.filesVisible}
        onSelectThread={(threadId) => void workspaceConnection.selectThread(threadId)}
        onToggleCollaborationPanel={panelVisibility.toggleCollaboration}
        onToggleDirectoryPanel={panelVisibility.toggleFiles}
        onUpdateRoomStatus={(open) => void invite.updateRoomStatus(open)}
        onOpenWorkspace={() => void workspaceConnection.openDialog()}
        onCreateInvite={() => void invite.create()}
        onToggleTheme={() =>
          setThemeMode((current) => (current === "dark" ? "light" : "dark"))
        }
        onResetSession={resetSession}
      />
      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      <WorkspacePanelLayout
        className={[
          "workspace",
          workspaceConnected ? "workspace-with-files" : "",
          workspaceConnected && workspaceFiles.editorExpanded
            ? "workspace-editor-expanded"
            : "",
        ]
          .filter(Boolean)
          .join(" ")}
        withFiles={workspaceConnected}
        editorExpanded={workspaceFiles.editorExpanded}
        showFiles={panelVisibility.filesVisible}
        showPeople={panelVisibility.collaborationVisible}
        storageScope={panelStorageScope}
      >
        {workspaceConnected && workspaceSummary ? (
          <section
            className="workspace-file-dock"
            aria-label="项目文件与代码编辑器"
            data-workspace-panel="files"
          >
            <Suspense
              fallback={
                <div
                  className="workspace-file-dock-loading"
                  aria-label="正在加载项目文件"
                >
                  <Skeleton>
                    <SkeletonItem />
                    <SkeletonItem />
                    <SkeletonItem />
                  </Skeleton>
                </div>
              }
            >
              <IdeWorkspace
                key={[
                  session?.id ?? "session",
                  workspaceSummary.selectedThreadId ?? "thread",
                  workspaceSummary.rootLabel ?? "root",
                ].join(":")}
                files={workspaceSummary.files}
                fileChanges={workspaceFileChanges}
                rootLabel={workspaceSummary.rootLabel}
                hostDeviceLabel={workspaceSummary.hostDeviceLabel}
                selectedThreadLabel={
                  workspaceSummary.selectedThread?.name ||
                  workspaceSummary.selectedThread?.preview ||
                  null
                }
                syncedAt={workspaceSummary.syncedAt}
                themeMode={themeMode}
                readOnly={workspaceReadOnly}
                readOnlyReason={
                  workspaceReadOnly
                    ? "房主尚未为你开放项目文件写入权限。"
                    : undefined
                }
                loading={workspaceConnection.loading}
                embedded
                editorExpanded={workspaceFiles.editorExpanded}
                onEditorExpandedChange={workspaceFiles.setEditorExpanded}
                onReadFile={workspaceFiles.readFile}
                onSaveFile={workspaceFiles.saveFile}
                onRefresh={workspaceConnection.reload}
                openFileRequest={workspaceFiles.openFileRequest}
                storageScope={`${session?.id ?? "session"}:${
                  workspaceSummary.selectedThreadId ?? "thread"
                }`}
              />
            </Suspense>
          </section>
        ) : null}
        <CollaborationPanel
          data-workspace-panel="people"
          membersExpanded={membersExpanded}
          pendingMemberCount={pendingMemberCount}
          members={members}
          loading={loading}
          currentMember={member}
          owner={owner}
          workspaceAccessUpdatingMemberId={
            collaboration.workspaceAccessUpdatingMemberId
          }
          identityForMember={identityForMember}
          onToggleMembers={() => setMembersExpanded((current) => !current)}
          onApproveMember={(target) => void collaboration.approveMember(target)}
          onUpdateWorkspaceFileAccess={(target, access) =>
            void collaboration.updateWorkspaceFileAccess(target, access)
          }
          chatMessages={chatMessages}
          chatStreamRef={chatStreamRef}
          approved={approved}
          sessionId={session?.id ?? null}
          token={token}
          onAttachmentError={composer.showAttachmentError}
          draggingChatFiles={composer.draggingChatFiles}
          onDraggingChatFilesChange={composer.setDraggingChatFiles}
          submitting={submission.submitting}
          preparingChatAttachments={composer.preparingChatAttachments}
          chatAttachmentInputRef={composer.chatAttachmentInputRef}
          pendingChatAttachments={composer.pendingChatAttachments}
          onRemoveChatAttachment={(attachmentId) =>
            composer.setPendingChatAttachments((current) =>
              current.filter((item) => item.id !== attachmentId),
            )
          }
          onAddChatAttachments={(files) => void composer.addChatAttachments(files)}
          chatInputRef={composer.chatInputRef}
          chatDraft={composer.chatDraft}
          onChatDraftChange={composer.setChatDraft}
          roomOpen={roomOpen}
          canSendChat={canSendChat}
          onSendChat={() => void submission.sendMessage("chat")}
        />
        <main className="chat-panel" data-workspace-panel="chat">
          <div className="chat-heading">
            <div>
              <p className="session-id">{session ? session.id : "尚未连接会话"}</p>
              <h2>{session?.name ?? "开始一个共享任务"}</h2>
            </div>
            {approved ? (
              <Button
                appearance="subtle"
                icon={<ArrowSyncRegular />}
                title="刷新消息和成员"
                aria-label="刷新消息和成员"
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
        <ActivityPanel data-workspace-panel="activity" activities={activities} />
      </WorkspacePanelLayout>
    </>
  );
}
