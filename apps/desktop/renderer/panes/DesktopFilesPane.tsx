import { Skeleton, SkeletonItem } from "@fluentui/react-components";
import { lazy, Suspense } from "react";
import type { DashboardViewModel } from "../../../dashboard/src/app/dashboard-view-model.js";

const IdeWorkspace = lazy(
  () => import("../../../dashboard/src/ide/shell/IdeWorkspace.js"),
);

interface DesktopFilesPaneProps {
  dataScope: string;
  model: DashboardViewModel;
  taskScope: string;
}

export function DesktopFilesPane({
  dataScope,
  model,
  taskScope,
}: DesktopFilesPaneProps) {
  const workspaceSummary = model.workspaceHistory.summary;
  if (!workspaceSummary) return null;

  return (
    <section className="desktop-files-pane" aria-label="项目 IDE">
      <Suspense
        fallback={
          <div className="desktop-files-loading" aria-label="正在加载项目 IDE">
            <Skeleton>
              <SkeletonItem />
              <SkeletonItem />
              <SkeletonItem />
            </Skeleton>
          </div>
        }
      >
        <IdeWorkspace
          key={`${dataScope}:${taskScope}`}
          files={workspaceSummary.files}
          directories={workspaceSummary.directories ?? []}
          fileChanges={model.workspaceFileChanges}
          rootLabel={workspaceSummary.rootLabel}
          hostDeviceLabel={workspaceSummary.hostDeviceLabel}
          selectedThreadLabel={
            workspaceSummary.selectedThread?.name ||
            workspaceSummary.selectedThread?.preview ||
            null
          }
          syncedAt={workspaceSummary.syncedAt}
          themeMode={model.themeMode}
          readOnly={model.workspaceReadOnly}
          {...(model.workspaceReadOnly
            ? { readOnlyReason: "房主尚未为你开放项目文件写入权限。" }
            : {})}
          loading={model.workspaceConnection.filesLoading}
          embedded
          editorExpanded={model.workspaceFiles.editorExpanded}
          onEditorExpandedChange={model.workspaceFiles.setEditorExpanded}
          onReadFile={model.workspaceFiles.readFile}
          onSaveFile={model.workspaceFiles.saveFile}
          onCreateFile={model.workspaceFiles.createFile}
          onCreateDirectory={model.workspaceFiles.createDirectory}
          onRenameEntry={model.workspaceFiles.renameEntry}
          onRefresh={model.workspaceConnection.reload}
          openFileRequest={model.workspaceFiles.openFileRequest}
          storageScope={taskScope}
          taskUiScope={taskScope}
          workspaceDataScope={dataScope}
        />
      </Suspense>
    </section>
  );
}
