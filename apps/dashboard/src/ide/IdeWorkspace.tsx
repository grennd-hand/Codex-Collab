import Editor, { DiffEditor } from "@monaco-editor/react";
import {
  Badge,
  Button,
  Input,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Skeleton,
  SkeletonItem,
  Tooltip,
} from "@fluentui/react-components";
import {
  ArrowSyncRegular,
  CheckmarkCircleRegular,
  ChevronDownRegular,
  ChevronRightRegular,
  DismissRegular,
  DocumentRegular,
  FolderOpenRegular,
  FolderRegular,
  LockClosedRegular,
  PanelLeftRegular,
  SaveRegular,
  SearchRegular,
  WarningRegular,
} from "@fluentui/react-icons";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import {
  buildFileTree,
  collectDirectoryPaths,
  filterFileTree,
  languageForPath,
  type IdeFileTreeNode,
} from "./file-tree.js";
import "./monaco-setup.js";
import type {
  IdeFileDocument,
  IdeSaveResult,
  IdeWorkspaceProps,
} from "./types.js";
import "./ide-workspace.css";

interface ConflictState {
  remote: IdeFileDocument;
  message: string;
}

interface EditorTabState {
  path: string;
  status: "loading" | "ready" | "error";
  value: string;
  savedValue: string;
  sha256: string;
  error: string | null;
  saveError: string | null;
  saving: boolean;
  savedNotice: boolean;
  conflict: ConflictState | null;
}

function fileName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
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

function messageFromError(caught: unknown): string {
  return caught instanceof Error ? caught.message : "文件操作未完成。";
}

function TreeItem({
  node,
  depth,
  activePath,
  expanded,
  forceExpanded,
  onToggle,
  onOpen,
}: {
  node: IdeFileTreeNode;
  depth: number;
  activePath: string | null;
  expanded: ReadonlySet<string>;
  forceExpanded: boolean;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  const isDirectory = node.kind === "directory";
  const isExpanded = forceExpanded || expanded.has(node.path);
  const style = { "--ide-tree-depth": depth } as CSSProperties;

  return (
    <div className="ide-tree-item" role="treeitem" aria-expanded={isDirectory ? isExpanded : undefined}>
      <button
        type="button"
        className={`ide-tree-row ${activePath === node.path ? "active" : ""}`}
        style={style}
        title={node.path}
        onClick={() => (isDirectory ? onToggle(node.path) : onOpen(node.path))}
      >
        <span className="ide-tree-chevron" aria-hidden="true">
          {isDirectory ? (
            isExpanded ? <ChevronDownRegular /> : <ChevronRightRegular />
          ) : null}
        </span>
        <span className="ide-tree-kind" aria-hidden="true">
          {isDirectory ? (
            isExpanded ? <FolderOpenRegular /> : <FolderRegular />
          ) : (
            <DocumentRegular />
          )}
        </span>
        <span className="ide-tree-name">{node.name}</span>
        {node.file ? (
          <span className="ide-tree-size">{formatFileSize(node.file.size)}</span>
        ) : null}
      </button>
      {isDirectory && isExpanded ? (
        <div role="group">
          {node.children.map((child) => (
            <TreeItem
              node={child}
              depth={depth + 1}
              activePath={activePath}
              expanded={expanded}
              forceExpanded={forceExpanded}
              onToggle={onToggle}
              onOpen={onOpen}
              key={child.id}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ExplorerSkeleton() {
  return (
    <div className="ide-explorer-skeleton" aria-label="正在加载项目文件">
      {[78, 62, 86, 70, 90, 54].map((width, index) => (
        <Skeleton key={`${width}-${index}`}>
          <SkeletonItem style={{ width: `${width}%` }} />
        </Skeleton>
      ))}
    </div>
  );
}

export default function IdeWorkspace({
  files,
  rootLabel,
  hostDeviceLabel,
  selectedThreadLabel,
  syncedAt,
  themeMode,
  readOnly,
  readOnlyReason,
  loading = false,
  onReadFile,
  onSaveFile,
  onRefresh,
  onClose,
}: IdeWorkspaceProps) {
  const tree = useMemo(() => buildFileTree(files), [files]);
  const [query, setQuery] = useState("");
  const visibleTree = useMemo(() => filterFileTree(tree, query), [query, tree]);
  const allDirectories = useMemo(() => collectDirectoryPaths(tree), [tree]);
  const [expanded, setExpanded] = useState<Set<string>>(allDirectories);
  const [tabs, setTabs] = useState<EditorTabState[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [mobileExplorerOpen, setMobileExplorerOpen] = useState(false);

  useEffect(() => {
    setExpanded((current) => {
      const next = new Set(current);
      for (const directory of allDirectories) next.add(directory);
      return next;
    });
  }, [allDirectories]);

  const updateTab = useCallback(
    (path: string, update: (tab: EditorTabState) => EditorTabState) => {
      setTabs((current) =>
        current.map((tab) => (tab.path === path ? update(tab) : tab)),
      );
    },
    [],
  );

  const loadFile = useCallback(
    async (path: string) => {
      setActivePath(path);
      setMobileExplorerOpen(false);
      const existing = tabs.find((tab) => tab.path === path);
      if (existing && existing.status !== "error") return;

      if (!existing) {
        setTabs((current) =>
          current.some((tab) => tab.path === path)
            ? current
            : [
                ...current,
                {
                  path,
                  status: "loading",
                  value: "",
                  savedValue: "",
                  sha256: "",
                  error: null,
                  saveError: null,
                  saving: false,
                  savedNotice: false,
                  conflict: null,
                },
              ],
        );
      } else {
        updateTab(path, (tab) => ({ ...tab, status: "loading", error: null }));
      }

      try {
        const document = await onReadFile(path);
        updateTab(path, (tab) => ({
          ...tab,
          status: "ready",
          value: document.content,
          savedValue: document.content,
          sha256: document.sha256,
          error: null,
          saveError: null,
          conflict: null,
        }));
      } catch (caught) {
        updateTab(path, (tab) => ({
          ...tab,
          status: "error",
          error: messageFromError(caught),
        }));
      }
    },
    [onReadFile, tabs, updateTab],
  );

  const activeTab = tabs.find((tab) => tab.path === activePath) ?? null;
  const activeDirty = Boolean(
    activeTab?.status === "ready" && activeTab.value !== activeTab.savedValue,
  );
  const activeConfigReadOnly = activePath?.startsWith(".codex/") ?? false;
  const activeFileReadOnly = readOnly || activeConfigReadOnly;
  const activeReadOnlyReason = activeConfigReadOnly
    ? ".codex 配置是单独的只读共享范围，项目文件写权限不会开放此目录。"
    : readOnlyReason ?? "当前成员只有项目文件只读权限。";

  const saveTab = useCallback(
    async (path: string) => {
      const tab = tabs.find((candidate) => candidate.path === path);
      if (
        !tab ||
        tab.status !== "ready" ||
        tab.saving ||
        tab.value === tab.savedValue ||
        readOnly ||
        path.startsWith(".codex/") ||
        tab.conflict
      ) {
        return;
      }

      updateTab(path, (current) => ({
        ...current,
        saving: true,
        saveError: null,
        savedNotice: false,
      }));
      try {
        const result: IdeSaveResult = await onSaveFile({
          path,
          content: tab.value,
          expectedSha256: tab.sha256,
        });
        if (result.status === "conflict") {
          updateTab(path, (current) => ({
            ...current,
            saving: false,
            conflict: {
              remote: result.file,
              message:
                result.message ??
                "文件在你打开后已被修改。请比较本地草稿与主机版本。",
            },
          }));
          return;
        }
        updateTab(path, (current) => ({
          ...current,
          saving: false,
          value: result.file.content,
          savedValue: result.file.content,
          sha256: result.file.sha256,
          savedNotice: true,
          conflict: null,
        }));
      } catch (caught) {
        updateTab(path, (current) => ({
          ...current,
          saving: false,
          saveError: messageFromError(caught),
        }));
      }
    },
    [onSaveFile, readOnly, tabs, updateTab],
  );

  useEffect(() => {
    const handleSaveShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLocaleLowerCase() !== "s") {
        return;
      }
      event.preventDefault();
      if (activePath) void saveTab(activePath);
    };
    window.addEventListener("keydown", handleSaveShortcut);
    return () => window.removeEventListener("keydown", handleSaveShortcut);
  }, [activePath, saveTab]);

  const closeTab = (path: string) => {
    const target = tabs.find((tab) => tab.path === path);
    if (
      target?.status === "ready" &&
      target.value !== target.savedValue &&
      !window.confirm(`关闭 ${fileName(path)} 并放弃未保存的更改吗？`)
    ) {
      return;
    }
    const index = tabs.findIndex((tab) => tab.path === path);
    const next = tabs.filter((tab) => tab.path !== path);
    setTabs(next);
    if (activePath === path) {
      setActivePath(next[Math.min(index, next.length - 1)]?.path ?? null);
    }
  };

  const keepLocalDraft = () => {
    if (!activeTab?.conflict) return;
    updateTab(activeTab.path, (tab) => ({
      ...tab,
      savedValue: tab.conflict?.remote.content ?? tab.savedValue,
      sha256: tab.conflict?.remote.sha256 ?? tab.sha256,
      conflict: null,
      saveError: null,
    }));
  };

  const useRemoteVersion = () => {
    if (!activeTab?.conflict) return;
    updateTab(activeTab.path, (tab) => {
      const remote = tab.conflict?.remote;
      if (!remote) return tab;
      return {
        ...tab,
        value: remote.content,
        savedValue: remote.content,
        sha256: remote.sha256,
        conflict: null,
        saveError: null,
        savedNotice: false,
      };
    });
  };

  const forceExpanded = query.trim().length > 0;
  const lineCount = activeTab?.value.split("\n").length ?? 0;
  const language = activePath ? languageForPath(activePath) : "plaintext";

  return (
    <section
      className={`ide-shell ${mobileExplorerOpen ? "explorer-mobile-open" : ""}`}
      aria-label="Codex Collab 项目 IDE"
    >
      <header className="ide-titlebar">
        <div className="ide-title-copy">
          <strong>项目 IDE</strong>
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
          <Tooltip content="显示或隐藏文件资源管理器" relationship="label">
            <Button
              appearance="subtle"
              icon={<PanelLeftRegular />}
              className="ide-mobile-explorer-toggle"
              aria-expanded={mobileExplorerOpen}
              onClick={() => setMobileExplorerOpen((current) => !current)}
            />
          </Tooltip>
          <Tooltip content="刷新项目文件" relationship="label">
            <Button
              appearance="subtle"
              icon={<ArrowSyncRegular />}
              aria-label="刷新项目文件"
              disabled={loading}
              onClick={() => void onRefresh()}
            />
          </Tooltip>
          <Tooltip content="关闭 IDE" relationship="label">
            <Button
              appearance="subtle"
              icon={<DismissRegular />}
              aria-label="关闭 IDE"
              onClick={onClose}
            />
          </Tooltip>
        </div>
      </header>

      <div className="ide-workbench">
        <aside className="ide-explorer" aria-label="文件资源管理器">
          <div className="ide-pane-heading">
            <strong>资源管理器</strong>
            <Badge appearance="tint">{files.length}</Badge>
          </div>
          <div className="ide-search">
            <Input
              size="small"
              value={query}
              placeholder="按路径搜索"
              aria-label="搜索项目文件"
              contentBefore={<SearchRegular />}
              onChange={(_, data) => setQuery(data.value)}
            />
          </div>
          <div className="ide-tree" role="tree" aria-label="项目文件">
            {loading && files.length === 0 ? <ExplorerSkeleton /> : null}
            {!loading && files.length === 0 ? (
              <div className="ide-state ide-state-compact">
                <FolderOpenRegular aria-hidden="true" />
                <strong>没有可共享的文本文件</strong>
                <span>同步工作区后，安全范围内的文件会显示在这里。</span>
              </div>
            ) : null}
            {files.length > 0 && visibleTree.length === 0 ? (
              <div className="ide-state ide-state-compact">
                <SearchRegular aria-hidden="true" />
                <strong>没有匹配文件</strong>
                <span>尝试缩短路径关键词。</span>
              </div>
            ) : null}
            {visibleTree.map((node) => (
              <TreeItem
                node={node}
                depth={0}
                activePath={activePath}
                expanded={expanded}
                forceExpanded={forceExpanded}
                onToggle={(path) =>
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(path)) next.delete(path);
                    else next.add(path);
                    return next;
                  })
                }
                onOpen={(path) => void loadFile(path)}
                key={node.id}
              />
            ))}
          </div>
        </aside>

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
                    <button type="button" onClick={() => setActivePath(tab.path)}>
                      <DocumentRegular aria-hidden="true" />
                      <span>{fileName(tab.path)}</span>
                      {dirty ? <i aria-label="有未保存的更改" /> : null}
                    </button>
                    <button
                      type="button"
                      className="ide-tab-close"
                      aria-label={`关闭 ${fileName(tab.path)}`}
                      onClick={() => closeTab(tab.path)}
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
                onClick={() => activePath && void saveTab(activePath)}
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
                <Button size="small" appearance="secondary" onClick={useRemoteVersion}>
                  使用主机版本
                </Button>
                <Button size="small" appearance="primary" onClick={keepLocalDraft}>
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
                <Button appearance="primary" onClick={() => void loadFile(activeTab.path)}>
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
                onChange={(value) =>
                  updateTab(activeTab.path, (tab) => ({
                    ...tab,
                    value: value ?? "",
                    saveError: null,
                    savedNotice: false,
                  }))
                }
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
      </div>
    </section>
  );
}
