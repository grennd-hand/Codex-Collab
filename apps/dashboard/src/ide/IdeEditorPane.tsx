import Editor, { DiffEditor, type OnMount } from "@monaco-editor/react";
import {
  Badge,
  Button,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Skeleton,
  SkeletonItem,
} from "@fluentui/react-components";
import {
  CheckmarkCircleRegular,
  DismissRegular,
  DocumentRegular,
  LockClosedRegular,
  SaveRegular,
  WarningRegular,
} from "@fluentui/react-icons";
import type { EditorTabState } from "./ide-tab-state.js";
import { fileName } from "./ide-tab-state.js";

interface IdeEditorPaneProps {
  tabs: EditorTabState[];
  activePath: string | null;
  activeTab: EditorTabState | null;
  activeDirty: boolean;
  activeFileReadOnly: boolean;
  activeConfigReadOnly: boolean;
  activeReadOnlyReason: string;
  language: string;
  lineCount: number;
  themeMode: "light" | "dark";
  onActivateTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  onSaveTab: (path: string) => void;
  onRetryFile: (path: string) => void;
  onUseRemoteVersion: () => void;
  onKeepLocalDraft: () => void;
  onUpdateValue: (path: string, value: string) => void;
}

const handleEditorMount: OnMount = (editor) => {
  editor.layout();
  window.requestAnimationFrame(() => editor.layout());
};

export function IdeEditorPane({
  tabs,
  activePath,
  activeTab,
  activeDirty,
  activeFileReadOnly,
  activeConfigReadOnly,
  activeReadOnlyReason,
  language,
  lineCount,
  themeMode,
  onActivateTab,
  onCloseTab,
  onSaveTab,
  onRetryFile,
  onUseRemoteVersion,
  onKeepLocalDraft,
  onUpdateValue,
}: IdeEditorPaneProps) {
  return (
    <main className="ide-editor-pane">
      <div className="ide-tabs" role="tablist" aria-label="打开的文件">
        {tabs.length === 0 ? (
          <span className="ide-tabs-placeholder">未打开文件</span>
        ) : (
          tabs.map((tab) => {
            const dirty = tab.status === "ready" && tab.value !== tab.savedValue;
            return (
              <div
                className={`ide-tab ${activePath === tab.path ? "active" : ""}`}
                role="tab"
                aria-selected={activePath === tab.path}
                title={tab.path}
                key={tab.path}
              >
                <button type="button" onClick={() => onActivateTab(tab.path)}>
                  <DocumentRegular aria-hidden="true" />
                  <span>{fileName(tab.path)}</span>
                  {dirty ? <i aria-label="有未保存的更改" /> : null}
                </button>
                <button
                  type="button"
                  className="ide-tab-close"
                  aria-label={`关闭 ${fileName(tab.path)}`}
                  onClick={() => onCloseTab(tab.path)}
                >
                  <DismissRegular />
                </button>
              </div>
            );
          })
        )}
      </div>

      <div className="ide-commandbar">
        <div className="ide-breadcrumb" title={activePath ?? undefined}>
          {activePath ? activePath.split("/").join(" / ") : "选择文件开始编辑"}
        </div>
        <div className="ide-editor-actions">
          {activeFileReadOnly ? (
            <Badge appearance="tint" icon={<LockClosedRegular />}>
              {activeConfigReadOnly ? "配置只读" : "只读"}
            </Badge>
          ) : null}
          <Button
            size="small"
            appearance="primary"
            icon={<SaveRegular />}
            disabled={
              activeFileReadOnly ||
              !activeDirty ||
              activeTab?.saving ||
              Boolean(activeTab?.conflict)
            }
            onClick={() => activePath && onSaveTab(activePath)}
          >
            {activeTab?.saving ? "保存中" : "保存"}
          </Button>
        </div>
      </div>

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

      <div className="ide-editor-stage">
        {!activeTab ? (
          <div className="ide-state ide-state-editor">
            <DocumentRegular aria-hidden="true" />
            <strong>打开一个项目文件</strong>
            <span>从资源管理器选择文件。支持搜索、标签页和 Ctrl+S 保存。</span>
          </div>
        ) : null}
        {activeTab?.status === "loading" ? (
          <div className="ide-editor-loading" aria-label="正在读取文件">
            <Skeleton>
              <SkeletonItem style={{ width: "46%" }} />
              <SkeletonItem style={{ width: "78%" }} />
              <SkeletonItem style={{ width: "66%" }} />
              <SkeletonItem style={{ width: "84%" }} />
            </Skeleton>
          </div>
        ) : null}
        {activeTab?.status === "error" ? (
          <div className="ide-state ide-state-editor error">
            <WarningRegular aria-hidden="true" />
            <strong>无法打开文件</strong>
            <span>{activeTab.error}</span>
            <Button appearance="primary" onClick={() => onRetryFile(activeTab.path)}>
              重试
            </Button>
          </div>
        ) : null}
        {activeTab?.status === "ready" && activeTab.conflict ? (
          <DiffEditor
            original={activeTab.conflict.remote.content}
            modified={activeTab.value}
            language={language}
            theme={themeMode === "dark" ? "vs-dark" : "vs"}
            options={{
              automaticLayout: true,
              readOnly: true,
              renderSideBySide: true,
              minimap: { enabled: false },
              fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
              fontSize: 13,
              scrollBeyondLastLine: false,
              wordWrap: "off",
            }}
          />
        ) : null}
        {activeTab?.status === "ready" && !activeTab.conflict ? (
          <Editor
            path={`codex-collab://workspace/${activeTab.path}`}
            height="100%"
            width="100%"
            value={activeTab.value}
            language={language}
            theme={themeMode === "dark" ? "vs-dark" : "vs"}
            loading={<span className="ide-monaco-loading">正在启动编辑器</span>}
            options={{
              automaticLayout: true,
              readOnly: activeFileReadOnly,
              readOnlyMessage: {
                value: activeReadOnlyReason,
              },
              accessibilityPageSize: 20,
              fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
              fontLigatures: true,
              fontSize: 13,
              lineHeight: 20,
              minimap: { enabled: true, maxColumn: 80, scale: 1 },
              padding: { top: 10, bottom: 18 },
              renderWhitespace: "selection",
              scrollBeyondLastLine: false,
              smoothScrolling: true,
              tabSize: 2,
              wordWrap: "off",
            }}
            onMount={handleEditorMount}
            onChange={(value) => onUpdateValue(activeTab.path, value ?? "")}
          />
        ) : null}
      </div>

      <footer className="ide-statusbar">
        <span>{activePath ? language : "就绪"}</span>
        {activeTab?.status === "ready" ? (
          <>
            <span>Ln {lineCount}</span>
            <span>SHA {activeTab.sha256.slice(0, 10)}</span>
            {activeTab.saving ? <span>等待主机保存</span> : null}
            {activeTab.savedNotice ? (
              <span className="ide-saved-status">
                <CheckmarkCircleRegular aria-hidden="true" /> 已保存
              </span>
            ) : activeDirty ? (
              <span>未保存</span>
            ) : null}
          </>
        ) : null}
      </footer>
    </main>
  );
}
