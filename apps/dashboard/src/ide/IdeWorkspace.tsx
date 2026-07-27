import { languageForPath } from "./file-tree.js";
import { IdeEditorPane } from "./IdeEditorPane.js";
import { IdeExplorer } from "./IdeExplorer.js";
import { IdeTitlebar } from "./IdeTitlebar.js";
import { ResizableSplitPane } from "../layout/index.js";
import type { IdeWorkspaceProps } from "./types.js";
import { useIdeWorkspaceState } from "./useIdeWorkspaceState.js";
import "./monaco-setup.js";
import "./ide-workspace.css";

export default function IdeWorkspace({
  files,
  directories = [],
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
  onCreateFile,
  onCreateDirectory,
  onRenameEntry,
  onRefresh,
  openFileRequest = null,
  storageScope = "workspace",
  embedded = false,
  editorExpanded = true,
  onEditorExpandedChange,
  onClose,
}: IdeWorkspaceProps) {
  const workspace = useIdeWorkspaceState({
    files,
    directories,
    onCreateDirectory,
    onCreateFile,
    onRenameEntry,
    onEditorExpandedChange,
    onReadFile,
    onSaveFile,
    openFileRequest,
    readOnly,
    storageScope,
  });
  const {
    activePath,
    activeTab,
    closeTab,
    createDirectory,
    createFile,
    expandedDirectories,
    keepLocalDraft,
    loadFile,
    mobileExplorerOpen,
    query,
    renameEntry,
    saveTab,
    setActivePath,
    setExpandedDirectories,
    setMobileExplorerOpen,
    setQuery,
    shellRef,
    tabs,
    updateTab,
    useRemoteVersion,
    visibleTree,
  } = workspace;
  const activeDirty = Boolean(
    activeTab?.status === "ready" && activeTab.value !== activeTab.savedValue,
  );
  const activeConfigReadOnly = activePath?.startsWith(".codex/") ?? false;
  const activeFileReadOnly = readOnly || activeConfigReadOnly;
  const activeReadOnlyReason = activeConfigReadOnly
    ? ".codex 配置是单独的只读共享范围，项目文件写权限不会开放此目录。"
    : readOnlyReason ?? "当前成员只有项目文件只读权限。";
  const forceExpanded = query.trim().length > 0;
  const language = activePath ? languageForPath(activePath) : "plaintext";
  const showEditor = !embedded || editorExpanded;

  const explorerPane = (
    <IdeExplorer
      fileCount={files.length}
      directoryCount={directories.length}
      fileChanges={fileChanges}
      loading={loading}
      query={query}
      visibleTree={visibleTree}
      activePath={activePath}
      expandedDirectories={expandedDirectories}
      forceExpanded={forceExpanded}
      readOnly={readOnly}
      onQueryChange={setQuery}
      onToggleDirectory={(path) =>
        setExpandedDirectories((current) => {
          const next = new Set(current);
          if (next.has(path)) next.delete(path);
          else next.add(path);
          return next;
        })
      }
      onExpandDirectory={(path) =>
        setExpandedDirectories((current) => new Set([...current, path]))
      }
      onOpenFile={(path) => void loadFile(path)}
      onCreateFile={createFile}
      onCreateDirectory={createDirectory}
      onRenameEntry={renameEntry}
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
