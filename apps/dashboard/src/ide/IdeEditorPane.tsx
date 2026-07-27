import type { OnMount } from "@monaco-editor/react";
import {
  Badge,
  Button,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
} from "@fluentui/react-components";
import {
  CheckmarkCircleRegular,
  DismissRegular,
  DocumentRegular,
  LockClosedRegular,
  SaveRegular,
  WarningRegular,
} from "@fluentui/react-icons";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EditorTabState } from "./ide-tab-state.js";
import { fileName } from "./ide-tab-state.js";
import type { IdeOpenFileRequest } from "./types.js";
import { IdeEditorStage } from "./IdeEditorStage.js";

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
  navigationTarget?: IdeOpenFileRequest | null;
  onActivateTab: (path: string) => void;
  onCloseTab: (path: string) => void;
  onSaveTab: (path: string) => void;
  onRetryFile: (path: string) => void;
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
  navigationTarget = null,
  onActivateTab,
  onCloseTab,
  onSaveTab,
  onRetryFile,
  onUseRemoteVersion,
  onKeepLocalDraft,
  onUpdateValue,
}: IdeEditorPaneProps) {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
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
    editor.setPosition({ lineNumber: line, column });
    editor.revealPositionInCenter({ lineNumber: line, column });
    editor.focus();
    handledNavigationRef.current = navigationTarget.requestId;
  }, [activePath, activeTab?.status, navigationTarget]);

  const handleEditorMount: OnMount = useCallback(
    (editor) => {
      editorRef.current = editor;
      setEditorMounted(true);
      setCursorPosition({
        line: editor.getPosition()?.lineNumber ?? 1,
        column: editor.getPosition()?.column ?? 1,
      });
      editor.onDidChangeCursorPosition((event) =>
        setCursorPosition({
          line: event.position.lineNumber,
          column: event.position.column,
        }),
      );
      editor.layout();
      window.requestAnimationFrame(() => {
        editor.layout();
        revealNavigationTarget();
      });
    },
    [revealNavigationTarget],
  );

  useEffect(() => {
    if (!editorMounted) return;
    const editor = editorRef.current;
    const node = editor?.getContainerDomNode();
    if (!editor || !node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => editor.layout());
    observer.observe(node.parentElement ?? node);
    return () => observer.disconnect();
  }, [editorMounted]);

  useEffect(() => {
    revealNavigationTarget();
  }, [revealNavigationTarget]);

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

      <IdeEditorStage
        activeTab={activeTab}
        activeFileReadOnly={activeFileReadOnly}
        activeReadOnlyReason={activeReadOnlyReason}
        language={language}
        themeMode={themeMode}
        onEditorMount={handleEditorMount}
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
