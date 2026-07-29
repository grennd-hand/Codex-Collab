import { Button } from "@fluentui/react-components";
import {
  ArrowSyncRegular,
  DismissRegular,
  PanelLeftContractRegular,
  PanelLeftExpandRegular,
  PanelLeftRegular,
} from "@fluentui/react-icons";

interface IdeTitlebarProps {
  showEditor: boolean;
  rootLabel: string | null;
  selectedThreadLabel: string | null;
  hostDeviceLabel: string | null;
  syncedAt: string | null;
  loading: boolean;
  embedded: boolean;
  mobileExplorerOpen: boolean;
  onToggleMobileExplorer: () => void;
  onRefresh: () => void;
  onToggleEditor: () => void;
  onClose?: () => void;
}

function formatSyncTime(value: string | null): string {
  if (!value) return "尚未同步";
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function IdeTitlebar({
  showEditor,
  rootLabel,
  selectedThreadLabel,
  hostDeviceLabel,
  syncedAt,
  loading,
  embedded,
  mobileExplorerOpen,
  onToggleMobileExplorer,
  onRefresh,
  onToggleEditor,
  onClose,
}: IdeTitlebarProps) {
  const editorToggleLabel = showEditor ? "收起代码编辑器" : "展开代码编辑器";
  const editorToggleTitle = showEditor
    ? "收起编辑器，只显示目录"
    : "展开代码编辑器";

  return (
    <header className="ide-titlebar">
      <div className="ide-title-copy">
        <strong>{showEditor ? "项目 IDE" : "项目文件"}</strong>
        <span title={rootLabel ?? "未连接项目根目录"}>
          {rootLabel ?? "未连接项目根目录"}
        </span>
      </div>
      <div className="ide-context" aria-label="工作区上下文">
        <span>{selectedThreadLabel ?? "未选择 Codex 任务"}</span>
        <span>{hostDeviceLabel ?? "等待主机"}</span>
        <span>{formatSyncTime(syncedAt)}</span>
      </div>
      <div className="ide-title-actions">
        {showEditor ? (
          <Button
            appearance="subtle"
            icon={<PanelLeftRegular />}
            className="ide-mobile-explorer-toggle ide-toolbar-button"
            aria-label="显示或隐藏文件资源管理器"
            title="显示或隐藏文件资源管理器"
            aria-expanded={mobileExplorerOpen}
            onClick={onToggleMobileExplorer}
          />
        ) : null}
        <Button
          appearance="subtle"
          icon={<ArrowSyncRegular />}
          className="ide-toolbar-button"
          aria-label="刷新项目文件"
          title="刷新项目文件"
          disabled={loading}
          onClick={onRefresh}
        />
        {embedded ? (
          <Button
            appearance="subtle"
            icon={
              showEditor ? <PanelLeftContractRegular /> : <PanelLeftExpandRegular />
            }
            className="ide-toolbar-button"
            aria-label={editorToggleLabel}
            title={editorToggleTitle}
            aria-expanded={showEditor}
            onClick={onToggleEditor}
          />
        ) : onClose ? (
          <Button
            appearance="subtle"
            icon={<DismissRegular />}
            className="ide-toolbar-button"
            aria-label="关闭 IDE"
            title="关闭 IDE"
            onClick={onClose}
          />
        ) : null}
      </div>
    </header>
  );
}
