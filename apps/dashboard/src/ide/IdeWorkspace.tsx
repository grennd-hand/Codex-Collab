import { useCallback, useEffect, useMemo, useState } from "react";
import {
  buildFileTree,
  collectDirectoryPaths,
  filterFileTree,
  languageForPath,
} from "./file-tree.js";
import { IdeEditorPane } from "./IdeEditorPane.js";
import { IdeExplorer } from "./IdeExplorer.js";
import { IdeTitlebar } from "./IdeTitlebar.js";
import {
  createLoadingTab,
  fileName,
  messageFromError,
  type EditorTabState,
} from "./ide-tab-state.js";
import type { IdeSaveResult, IdeWorkspaceProps } from "./types.js";
import "./monaco-setup.js";
import "./ide-workspace.css";

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
  embedded = false,
  editorExpanded = true,
  onEditorExpandedChange,
  onClose,
}: IdeWorkspaceProps) {
  const tree = useMemo(() => buildFileTree(files), [files]);
  const [query, setQuery] = useState("");
  const visibleTree = useMemo(() => filterFileTree(tree, query), [query, tree]);
  const allDirectories = useMemo(() => collectDirectoryPaths(tree), [tree]);
  const [expandedDirectories, setExpandedDirectories] =
    useState<Set<string>>(allDirectories);
  const [tabs, setTabs] = useState<EditorTabState[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [mobileExplorerOpen, setMobileExplorerOpen] = useState(false);

  useEffect(() => {
    setExpandedDirectories((current) => {
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
      onEditorExpandedChange?.(true);
      setActivePath(path);
      setMobileExplorerOpen(false);
      const existing = tabs.find((tab) => tab.path === path);
      if (existing && existing.status !== "error") return;

      if (!existing) {
        setTabs((current) =>
          current.some((tab) => tab.path === path)
            ? current
            : [...current, createLoadingTab(path)],
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
    [onEditorExpandedChange, onReadFile, tabs, updateTab],
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
  const showEditor = !embedded || editorExpanded;

  return (
    <section
      className={[
        "ide-shell",
        embedded ? "ide-shell-embedded" : "",
        showEditor ? "ide-shell-editor-expanded" : "ide-shell-explorer-only",
        mobileExplorerOpen ? "explorer-mobile-open" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label="Codex Collab 项目 IDE"
    >
      <IdeTitlebar
        showEditor={showEditor}
        rootLabel={rootLabel}
        selectedThreadLabel={selectedThreadLabel}
        hostDeviceLabel={hostDeviceLabel}
        syncedAt={syncedAt}
        loading={loading}
        embedded={embedded}
        mobileExplorerOpen={mobileExplorerOpen}
        onToggleMobileExplorer={() =>
          setMobileExplorerOpen((current) => !current)
        }
        onRefresh={() => void onRefresh()}
        onToggleEditor={() => onEditorExpandedChange?.(!showEditor)}
        onClose={onClose}
      />

      <div className="ide-workbench">
        <IdeExplorer
          fileCount={files.length}
          loading={loading}
          query={query}
          visibleTree={visibleTree}
          activePath={activePath}
          expandedDirectories={expandedDirectories}
          forceExpanded={forceExpanded}
          onQueryChange={setQuery}
          onToggleDirectory={(path) =>
            setExpandedDirectories((current) => {
              const next = new Set(current);
              if (next.has(path)) next.delete(path);
              else next.add(path);
              return next;
            })
          }
          onOpenFile={(path) => void loadFile(path)}
        />

        {showEditor ? (
          <IdeEditorPane
            tabs={tabs}
            activePath={activePath}
            activeTab={activeTab}
            activeDirty={activeDirty}
            activeFileReadOnly={activeFileReadOnly}
            activeConfigReadOnly={activeConfigReadOnly}
            activeReadOnlyReason={activeReadOnlyReason}
            language={language}
            lineCount={lineCount}
            themeMode={themeMode}
            onActivateTab={setActivePath}
            onCloseTab={closeTab}
            onSaveTab={(path) => void saveTab(path)}
            onRetryFile={(path) => void loadFile(path)}
            onUseRemoteVersion={useRemoteVersion}
            onKeepLocalDraft={keepLocalDraft}
            onUpdateValue={(path, value) =>
              updateTab(path, (tab) => ({
                ...tab,
                value,
                saveError: null,
                savedNotice: false,
              }))
            }
          />
        ) : null}
      </div>
    </section>
  );
}
