import {
  Badge,
  Button,
  Input,
  Skeleton,
  SkeletonItem,
} from "@fluentui/react-components";
import {
  DocumentAddRegular,
  FolderAddRegular,
  FolderOpenRegular,
  SearchRegular,
} from "@fluentui/react-icons";
import type { CodexFileChange } from "@codex-collab/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import type { IdeFileTreeNode } from "./file-tree.js";
import {
  createEntryParentPath,
  type IdeCreateEntryKind,
  type PendingIdeCreate,
  type IdeTreeSelection,
} from "./ide-create-entry.js";
import { IdeExplorerTree } from "./IdeExplorerTree.js";

interface IdeExplorerProps {
  fileCount: number;
  directoryCount: number;
  loading: boolean;
  query: string;
  visibleTree: IdeFileTreeNode[];
  activePath: string | null;
  expandedDirectories: ReadonlySet<string>;
  fileChanges: readonly CodexFileChange[];
  forceExpanded: boolean;
  readOnly: boolean;
  onQueryChange: (value: string) => void;
  onToggleDirectory: (path: string) => void;
  onExpandDirectory: (path: string) => void;
  onOpenFile: (path: string) => void;
  onCreateFile: (path: string) => Promise<void>;
  onCreateDirectory: (path: string) => Promise<void>;
  onRenameEntry: (entry: IdeTreeSelection, destinationPath: string) => Promise<void>;
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

export function IdeExplorer({
  fileCount,
  directoryCount,
  loading,
  query,
  visibleTree,
  activePath,
  expandedDirectories,
  fileChanges,
  forceExpanded,
  readOnly,
  onQueryChange,
  onToggleDirectory,
  onExpandDirectory,
  onOpenFile,
  onCreateFile,
  onCreateDirectory,
  onRenameEntry,
}: IdeExplorerProps) {
  const [selection, setSelection] = useState<IdeTreeSelection | null>(null);
  const [pendingCreate, setPendingCreate] = useState<PendingIdeCreate | null>(null);
  const [pendingRename, setPendingRename] = useState<IdeTreeSelection | null>(null);
  const createIdRef = useRef(0);
  const entryCount = fileCount + directoryCount;
  useEffect(() => {
    if (activePath) setSelection({ kind: "file", path: activePath });
  }, [activePath]);

  const startCreate = (kind: IdeCreateEntryKind) => {
    const parentPath = createEntryParentPath(selection, activePath);
    onQueryChange("");
    if (parentPath) onExpandDirectory(parentPath);
    setPendingRename(null);
    setPendingCreate({ id: ++createIdRef.current, kind, parentPath });
  };
  const commitRename = async (
    entry: IdeTreeSelection,
    destinationPath: string,
  ) => {
    await onRenameEntry(entry, destinationPath);
    setPendingRename(null);
    setSelection({ kind: entry.kind, path: destinationPath });
  };

  const commitCreate = async (path: string) => {
    const pending = pendingCreate;
    if (!pending) return;
    if (pending.kind === "file") await onCreateFile(path);
    else await onCreateDirectory(path);
    setPendingCreate(null);
    setSelection({ kind: pending.kind, path });
    if (pending.kind === "directory") onExpandDirectory(path);
  };
  const changeByPath = useMemo(() => {
    const result = new Map<string, CodexFileChange>();
    for (const change of fileChanges) result.set(change.path.replaceAll("\\", "/"), change);
    return result;
  }, [fileChanges]);
  return (
    <aside className="ide-explorer" aria-label="文件资源管理器">
      <div className="ide-pane-heading">
        <strong>资源管理器</strong>
        <div className="ide-explorer-actions">
          {!readOnly ? (
            <>
              <Button
                appearance="subtle"
                size="small"
                icon={<DocumentAddRegular />}
                title="新建文件"
                aria-label="新建文件"
                onClick={() => startCreate("file")}
              />
              <Button
                appearance="subtle"
                size="small"
                icon={<FolderAddRegular />}
                title="新建文件夹"
                aria-label="新建文件夹"
                onClick={() => startCreate("directory")}
              />
            </>
          ) : null}
          <Badge appearance="tint">{fileCount}</Badge>
        </div>
      </div>
      <div className="ide-search">
        <Input
          size="small"
          value={query}
          placeholder="按路径搜索"
          aria-label="搜索项目文件"
          contentBefore={<SearchRegular />}
          onChange={(_, data) => onQueryChange(data.value)}
        />
      </div>
      <div className="ide-tree" role="tree" aria-label="项目文件">
        {loading && entryCount === 0 ? <ExplorerSkeleton /> : null}
        {!loading && entryCount === 0 && !pendingCreate ? (
          <div className="ide-state ide-state-compact">
            <FolderOpenRegular aria-hidden="true" />
            <strong>没有可共享的文本文件</strong>
            <span>同步工作区后，安全范围内的文件会显示在这里。</span>
          </div>
        ) : null}
        {entryCount > 0 && visibleTree.length === 0 && !pendingCreate ? (
          <div className="ide-state ide-state-compact">
            <SearchRegular aria-hidden="true" />
            <strong>没有匹配文件</strong>
            <span>尝试缩短路径关键词。</span>
          </div>
        ) : null}
        <IdeExplorerTree
          nodes={visibleTree}
          selectedPath={selection?.path ?? activePath}
          expanded={expandedDirectories}
          forceExpanded={forceExpanded}
          onToggle={onToggleDirectory}
          onOpen={onOpenFile}
          onSelect={setSelection}
          changeByPath={changeByPath}
          pendingCreate={pendingCreate}
          pendingRename={pendingRename}
          onCancelCreate={() => setPendingCreate(null)}
          onCommitCreate={commitCreate}
          onStartRename={(entry) => {
            if (readOnly) return;
            setPendingCreate(null);
            setPendingRename(entry);
          }}
          onCancelRename={() => setPendingRename(null)}
          onCommitRename={commitRename}
        />
      </div>
    </aside>
  );
}
