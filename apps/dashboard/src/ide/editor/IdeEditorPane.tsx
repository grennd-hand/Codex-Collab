import type { OnMount } from "@monaco-editor/react";
import {
  Badge,
  Button,
} from "@fluentui/react-components";
import {
  CheckmarkCircleRegular,
  DismissRegular,
  DocumentRegular,
  LockClosedRegular,
  SaveRegular,
} from "@fluentui/react-icons";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EditorTabState } from "../state/ide-tab-state.js";
import { fileName } from "../state/ide-tab-state.js";
import type { IdeOpenFileRequest } from "../state/types.js";
import { IdeEditorStage } from "./IdeEditorStage.js";
import { IdeEditorNotices } from "./IdeEditorNotices.js";
import {
  monacoModelScope,
  retainMonacoModel,
} from "./monaco-model-registry.js";

interface IdeEditorPaneProps {
  tabs: EditorTabState[];
  activePath: string | null;
  activeTab: EditorTabState | null;
  activeDirty: boolean;
  activeFileReadOnly: boolean;
  activeConfigReadOnly: boolean;
  activeReadOnlyReason: string;
  language: string;
  themeMode: "light" | "dark";
  taskUiScope: string;
  workspaceDataScope: string;
  navigationTarget?: IdeOpenFileRequest | null;
  onActivateTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  onSaveTab: (path: string) => void;
  onRetryFile: (path: string) => void;
  onReloadFile: (path: string) => void;
  onUseRemoteVersion: () => void;
  onKeepLocalDraft: () => void;
  onUpdateValue: (path: string, value: string) => void;
}

export function IdeEditorPane({
  tabs,
  activePath,
  activeTab,
  activeDirty,
  activeFileReadOnly,
  activeConfigReadOnly,
  activeReadOnlyReason,
  language,
  themeMode,
  taskUiScope,
  workspaceDataScope,
  navigationTarget = null,
  onActivateTab,
  onCloseTab,
  onSaveTab,
  onRetryFile,
  onReloadFile,
  onUseRemoteVersion,
  onKeepLocalDraft,
  onUpdateValue,
}: IdeEditorPaneProps) {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const cursorSubscriptionRef = useRef<{ dispose(): void } | null>(null);
  const handledNavigationRef = useRef<number | null>(null);
  const [editorMounted, setEditorMounted] = useState(false);
  const [cursorPosition, setCursorPosition] = useState({ line: 1, column: 1 });

  const revealNavigationTarget = useCallback(() => {
    const editor = editorRef.current;
    if (
      !editor ||
      !navigationTarget ||
      navigationTarget.path !== activePath ||
      activeTab?.status !== "ready" ||
      handledNavigationRef.current === navigationTarget.requestId
    ) {
      return;
    }
    const line = Math.max(1, Math.trunc(navigationTarget.line ?? 1));
    const column = Math.max(1, Math.trunc(navigationTarget.column ?? 1));
    const endLine = Math.max(line, Math.trunc(navigationTarget.endLine ?? line));
    const defaultEndColumn = endLine === line ? column : 1;
    const endColumn = Math.max(
      defaultEndColumn,
      Math.trunc(navigationTarget.endColumn ?? defaultEndColumn),
    );
    const range = {
      startLineNumber: line,
      startColumn: column,
      endLineNumber: endLine,
      endColumn,
    };
    editor.setSelection(range);
    editor.revealRangeInCenter(range);
    editor.focus();
    handledNavigationRef.current = navigationTarget.requestId;
  }, [activePath, activeTab?.status, navigationTarget]);

  const handleEditorMount: OnMount = useCallback(
    (editor) => {
      cursorSubscriptionRef.current?.dispose();
      editorRef.current = editor;
      setEditorMounted(true);
      setCursorPosition({
        line: editor.getPosition()?.lineNumber ?? 1,
        column: editor.getPosition()?.column ?? 1,
      });
      cursorSubscriptionRef.current = editor.onDidChangeCursorPosition((event) =>
        setCursorPosition({
          line: event.position.lineNumber,
          column: event.position.column,
        }),
      );
      editor.layout();
      window.requestAnimationFrame(() => {
        if (editorRef.current !== editor) return;
        editor.layout();
        revealNavigationTarget();
      });
    },
    [revealNavigationTarget],
  );

  const handleEditorUnmount = useCallback(
    (editor: Parameters<OnMount>[0]) => {
      if (editorRef.current !== editor) return;
      cursorSubscriptionRef.current?.dispose();
      cursorSubscriptionRef.current = null;
      editorRef.current = null;
      setEditorMounted(false);
    },
    [],
  );

  useEffect(() => {
    if (!editorMounted) return;
    const editor = editorRef.current;
    const node = editor?.getContainerDomNode();
    if (!editor || !node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (editorRef.current === editor) editor.layout();
    });
    observer.observe(node.parentElement ?? node);
    return () => observer.disconnect();
  }, [editorMounted]);

  useEffect(() => {
    revealNavigationTarget();
  }, [revealNavigationTarget]);
  useEffect(() => {
    if (!editorMounted) return;
    retainMonacoModel(
      workspaceDataScope,
      taskUiScope,
      monacoModelScope(workspaceDataScope, taskUiScope),
      editorRef.current?.getModel() ?? null,
    );
  }, [activePath, editorMounted, taskUiScope, workspaceDataScope]);

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

      <IdeEditorNotices
        activeDirty={activeDirty}
        activeFileReadOnly={activeFileReadOnly}
        activePath={activePath}
        activeReadOnlyReason={activeReadOnlyReason}
        activeTab={activeTab}
        onKeepLocalDraft={onKeepLocalDraft}
        onReloadFile={onReloadFile}
        onUseRemoteVersion={onUseRemoteVersion}
      />

      <IdeEditorStage
        activeTab={activeTab}
        activeFileReadOnly={activeFileReadOnly}
        activeReadOnlyReason={activeReadOnlyReason}
        language={language}
        themeMode={themeMode}
        taskUiScope={taskUiScope}
        workspaceDataScope={workspaceDataScope}
        onEditorMount={handleEditorMount}
        onEditorUnmount={handleEditorUnmount}
        onRetryFile={onRetryFile}
        onUpdateValue={onUpdateValue}
      />

      <footer className="ide-statusbar">
        <span>{activePath ? language : "就绪"}</span>
        {activeTab?.status === "ready" ? (
          <>
            <span>Ln {cursorPosition.line}, Col {cursorPosition.column}</span>
            <span>SHA {activeTab.sha256.slice(0, 10)}</span>
            {activeTab.saving ? <span>等待主机保存</span> : null}
            {activeTab.remoteState === "stale" ? <span>远端已更新</span> : null}
            {activeTab.remoteState === "deleted-remotely" ? (
              <span>远端已删除</span>
            ) : null}
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
