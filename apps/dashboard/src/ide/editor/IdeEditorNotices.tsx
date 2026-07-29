import {
  Button,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
} from "@fluentui/react-components";
import { LockClosedRegular, WarningRegular } from "@fluentui/react-icons";
import type { EditorTabState } from "../state/ide-tab-state.js";

interface IdeEditorNoticesProps {
  activeDirty: boolean;
  activeFileReadOnly: boolean;
  activePath: string | null;
  activeReadOnlyReason: string;
  activeTab: EditorTabState | null;
  onKeepLocalDraft: () => void;
  onReloadFile: (path: string) => void;
  onUseRemoteVersion: () => void;
}

export function IdeEditorNotices({
  activeDirty,
  activeFileReadOnly,
  activePath,
  activeReadOnlyReason,
  activeTab,
  onKeepLocalDraft,
  onReloadFile,
  onUseRemoteVersion,
}: IdeEditorNoticesProps) {
  return (
    <div className="ide-notices">
      {activeFileReadOnly ? (
        <div className="ide-readonly-notice">
          <LockClosedRegular aria-hidden="true" />
          <span>{activeReadOnlyReason}</span>
        </div>
      ) : null}
      {activeTab?.saveError ? (
        <MessageBar intent="error" className="ide-messagebar">
          <MessageBarBody>
            <MessageBarTitle>保存失败</MessageBarTitle>
            {activeTab.saveError}
          </MessageBarBody>
        </MessageBar>
      ) : null}
      {activeTab?.remoteState === "stale" && !activeTab.conflict ? (
        <MessageBar intent="warning" className="ide-messagebar">
          <MessageBarBody>
            <MessageBarTitle>主机版本已更新</MessageBarTitle>
            本地编辑状态已保留。保存时会先进行版本冲突检查。
            {!activeDirty ? (
              <Button
                appearance="transparent"
                size="small"
                onClick={() => activePath && onReloadFile(activePath)}
              >
                载入主机版本
              </Button>
            ) : null}
          </MessageBarBody>
        </MessageBar>
      ) : null}
      {activeTab?.remoteState === "deleted-remotely" ? (
        <MessageBar intent="error" className="ide-messagebar">
          <MessageBarBody>
            <MessageBarTitle>文件已在主机删除</MessageBarTitle>
            当前标签和未保存草稿会保留，不能直接覆盖已删除的文件。
          </MessageBarBody>
        </MessageBar>
      ) : null}
      {activeTab?.conflict ? (
        <div className="ide-conflict-bar" role="alert">
          <WarningRegular aria-hidden="true" />
          <div>
            <strong>检测到版本冲突</strong>
            <span>{activeTab.conflict.message}</span>
          </div>
          <Button size="small" appearance="secondary" onClick={onUseRemoteVersion}>
            使用主机版本
          </Button>
          <Button size="small" appearance="primary" onClick={onKeepLocalDraft}>
            保留草稿并重新保存
          </Button>
        </div>
      ) : null}
    </div>
  );
}
