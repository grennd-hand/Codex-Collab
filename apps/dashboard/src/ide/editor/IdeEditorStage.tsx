import Editor, { DiffEditor, type OnMount } from "@monaco-editor/react";
import { Button, Skeleton, SkeletonItem } from "@fluentui/react-components";
import { DocumentRegular, WarningRegular } from "@fluentui/react-icons";
import { useEffect, useRef } from "react";
import type { EditorTabState } from "../state/ide-tab-state.js";
import {
  monacoModelUri,
  monacoModelScope,
  retainMonacoModel,
} from "./monaco-model-registry.js";

interface IdeEditorStageProps {
  activeTab: EditorTabState | null;
  activeFileReadOnly: boolean;
  activeReadOnlyReason: string;
  language: string;
  themeMode: "light" | "dark";
  taskUiScope: string;
  workspaceDataScope: string;
  onEditorMount: OnMount;
  onEditorUnmount: (editor: Parameters<OnMount>[0]) => void;
  onRetryFile: (path: string) => void;
  onUpdateValue: (path: string, value: string) => void;
}

const sharedEditorOptions = {
  automaticLayout: true,
  fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
  fontSize: 13,
  scrollBeyondLastLine: false,
  wordWrap: "off" as const,
};

export function IdeEditorStage({
  activeTab,
  activeFileReadOnly,
  activeReadOnlyReason,
  language,
  themeMode,
  taskUiScope,
  workspaceDataScope,
  onEditorMount,
  onEditorUnmount,
  onRetryFile,
  onUpdateValue,
}: IdeEditorStageProps) {
  const theme = themeMode === "dark" ? "codex-collab-dark" : "codex-collab-light";
  return (
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
          theme={theme}
          options={{
            ...sharedEditorOptions,
            readOnly: true,
            renderSideBySide: true,
            minimap: { enabled: false },
            folding: true,
            foldingStrategy: "auto",
            showFoldingControls: "mouseover",
            bracketPairColorization: { enabled: true },
            guides: { indentation: true, bracketPairs: true },
          }}
        />
      ) : null}
      {activeTab?.status === "ready" && !activeTab.conflict ? (
        <ScopedMonacoEditor
          path={activeTab.path}
          value={activeTab.value}
          language={language}
          theme={theme}
          readOnly={activeFileReadOnly}
          readOnlyReason={activeReadOnlyReason}
          taskUiScope={taskUiScope}
          workspaceDataScope={workspaceDataScope}
          onMount={onEditorMount}
          onUnmount={onEditorUnmount}
          onChange={(value) => onUpdateValue(activeTab.path, value)}
        />
      ) : null}
    </div>
  );
}

interface ScopedMonacoEditorProps {
  language: string;
  path: string;
  readOnly: boolean;
  readOnlyReason: string;
  taskUiScope: string;
  theme: string;
  value: string;
  workspaceDataScope: string;
  onChange: (value: string) => void;
  onMount: OnMount;
  onUnmount: (editor: Parameters<OnMount>[0]) => void;
}

function ScopedMonacoEditor({
  language,
  path,
  readOnly,
  readOnlyReason,
  taskUiScope,
  theme,
  value,
  workspaceDataScope,
  onChange,
  onMount,
  onUnmount,
}: ScopedMonacoEditorProps) {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  const modelScope = monacoModelScope(workspaceDataScope, taskUiScope);
  useEffect(
    () => () => {
      if (editorRef.current) onUnmount(editorRef.current);
    },
    [onUnmount],
  );

  return (
    <Editor
      path={monacoModelUri(modelScope, path)}
      keepCurrentModel
      saveViewState
      height="100%"
      width="100%"
      value={value}
      language={language}
      theme={theme}
      loading={<span className="ide-monaco-loading">正在启动编辑器</span>}
      options={{
        ...sharedEditorOptions,
        readOnly,
        readOnlyMessage: { value: readOnlyReason },
        accessibilityPageSize: 20,
        fontLigatures: true,
        lineHeight: 20,
        folding: true,
        foldingStrategy: "auto",
        foldingHighlight: true,
        showFoldingControls: "mouseover",
        unfoldOnClickAfterEndOfLine: true,
        glyphMargin: true,
        renderLineHighlight: "all",
        bracketPairColorization: { enabled: true },
        guides: {
          indentation: true,
          highlightActiveIndentation: true,
          bracketPairs: true,
          highlightActiveBracketPair: true,
        },
        matchBrackets: "always",
        autoClosingBrackets: "languageDefined",
        autoClosingQuotes: "languageDefined",
        autoIndent: "full",
        stickyScroll: { enabled: true, maxLineCount: 5 },
        minimap: { enabled: true, maxColumn: 80, scale: 1 },
        padding: { top: 10, bottom: 18 },
        renderWhitespace: "selection",
        smoothScrolling: true,
        tabSize: 2,
      }}
      onMount={(editor, monaco) => {
        editorRef.current = editor;
        retainMonacoModel(
          workspaceDataScope,
          taskUiScope,
          modelScope,
          editor.getModel(),
        );
        onMount(editor, monaco);
      }}
      onChange={(nextValue) => onChange(nextValue ?? "")}
    />
  );
}
