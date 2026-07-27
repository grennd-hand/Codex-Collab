import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildFileTree,
  collectDirectoryPaths,
  filterFileTree,
  languageForPath,
} from "./file-tree.js";
import { IdeEditorPane } from "./IdeEditorPane.js";
import { IdeExplorer } from "./IdeExplorer.js";
import { IdeTitlebar } from "./IdeTitlebar.js";
import { ResizableSplitPane } from "../layout/index.js";
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
  fileChanges = [],
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
  openFileRequest = null,
  storageScope = "workspace",
  embedded = false,
  editorExpanded = true,
  onEditorExpandedChange,
  onClose,
}: IdeWorkspaceProps) {
  const tree = useMemo(() => buildFileTree(files), [files]);
  const [query, setQuery] = useState("");
  const visibleTree = useMemo(() => filterFileTree(tree, query), [query, tree]);
  const allDirectories = useMemo(() => collectDirectoryPaths(tree), [tree]);
  const expansionStorageKey = `codex-collab:ide:expanded:${storageScope}`;
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(
    () => {
      try {
        if (typeof window === "undefined") return new Set();
        const stored = window.localStorage.getItem(expansionStorageKey);
        const parsed = stored ? (JSON.parse(stored) as unknown) : [];
        return new Set(
          Array.isArray(parsed)
            ? parsed.filter((item): item is string => typeof item === "string")
            : [],
        );
      } catch {
        return new Set();
      }
    },
  );
  const [tabs, setTabs] = useState<EditorTabState[]>([]);
  const tabsRef = useRef<EditorTabState[]>([]);
  const loadingPathsRef = useRef(new Map<string, Promise<void>>());
  const handledOpenRequestRef = useRef<number | null>(null);
  const shellRef = useRef<HTMLElement>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [mobileExplorerOpen, setMobileExplorerOpen] = useState(false);

  useEffect(() => {
    setExpandedDirectories((current) => {
      const next = new Set([...current].filter((path) => allDirectories.has(path)));
      return next.size === current.size ? current : next;
    });
  }, [allDirectories]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        expansionStorageKey,
        JSON.stringify([...expandedDirectories]),
      );
    } catch {
      // Local layout preferences are optional.
    }
  }, [expandedDirectories, expansionStorageKey]);

  const updateTab = useCallback(
    (path: string, update: (tab: EditorTabState) => EditorTabState) => {
      setTabs((current) =>
        {
          const next = current.map((tab) =>
            tab.path === path ? update(tab) : tab,
          );
          tabsRef.current = next;
          return next;
        },
      );
    },
    [],
  );

  const loadFile = useCallback(
    async (path: string) => {
      onEditorExpandedChange?.(true);
      setActivePath(path);
      setMobileExplorerOpen(false);
      const ancestorPaths = path
        .replaceAll("\\", "/")
        .split("/")
        .slice(0, -1)
        .map((_part, index, parts) => parts.slice(0, index + 1).join("/"));
      setExpandedDirectories((current) => new Set([...current, ...ancestorPaths]));
      const existing = tabsRef.current.find((tab) => tab.path === path);
      if (existing && existing.status !== "error") return;

      const inFlight = loadingPathsRef.current.get(path);
      if (inFlight) return inFlight;

      if (!existing) {
        setTabs((current) => {
          const next = current.some((tab) => tab.path === path)
            ? current
            : [...current, createLoadingTab(path)];
          tabsRef.current = next;
          return next;
        });
      } else {
        updateTab(path, (tab) => ({ ...tab, status: "loading", error: null }));
      }

      const request = (async () => {
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
        } finally {
          loadingPathsRef.current.delete(path);
        }
      })();
      loadingPathsRef.current.set(path, request);
      return request;
    },
    [onEditorExpandedChange, onReadFile, updateTab],
  );

  const activeTab = tabs.find((tab) => tab.path === activePath) ?? null;

  useEffect(() => {
    if (
      !openFileRequest ||
      handledOpenRequestRef.current === openFileRequest.requestId
    ) {
      return;
    }
    handledOpenRequestRef.current = openFileRequest.requestId;
    void loadFile(openFileRequest.path);
  }, [loadFile, openFileRequest]);
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
      if (!shellRef.current?.contains(document.activeElement)) return;
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
    tabsRef.current = next;
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
  const language = activePath ? languageForPath(activePath) : "plaintext";
  const showEditor = !embedded || editorExpanded;
  const explorerPane = (
    <IdeExplorer
      fileCount={files.length}
      fileChanges={fileChanges}
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
  );
  const editorPane = (
    <IdeEditorPane
      tabs={tabs}
      activePath={activePath}
      activeTab={activeTab}
      activeDirty={activeDirty}
      activeFileReadOnly={activeFileReadOnly}
      activeConfigReadOnly={activeConfigReadOnly}
      activeReadOnlyReason={activeReadOnlyReason}
      language={language}
      themeMode={themeMode}
      navigationTarget={openFileRequest}
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
  );

  return (
    <section
      ref={shellRef}
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
        {showEditor ? (
          <ResizableSplitPane
            className="ide-workbench-split"
            primary={explorerPane}
            secondary={editorPane}
            defaultPrimarySize={embedded ? 232 : 252}
            minPrimarySize={180}
            maxPrimarySize={420}
            minSecondarySize={320}
            separatorLabel="调整资源管理器和代码编辑器宽度"
            primaryLabel="文件资源管理器"
            secondaryLabel="代码编辑器"
            storageKey={`codex-collab:ide:explorer-width:${storageScope}`}
          />
        ) : (
          explorerPane
        )}
      </div>
    </section>
  );
}
