import {
  Badge,
  Input,
  Skeleton,
  SkeletonItem,
} from "@fluentui/react-components";
import {
  ChevronDownRegular,
  ChevronRightRegular,
  DocumentRegular,
  FolderOpenRegular,
  FolderRegular,
  SearchRegular,
} from "@fluentui/react-icons";
import type { CodexFileChange } from "@codex-collab/protocol";
import { useMemo, type CSSProperties } from "react";
import type { IdeFileTreeNode } from "./file-tree.js";

interface IdeExplorerProps {
  fileCount: number;
  loading: boolean;
  query: string;
  visibleTree: IdeFileTreeNode[];
  activePath: string | null;
  expandedDirectories: ReadonlySet<string>;
  fileChanges: readonly CodexFileChange[];
  forceExpanded: boolean;
  onQueryChange: (value: string) => void;
  onToggleDirectory: (path: string) => void;
  onOpenFile: (path: string) => void;
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function TreeItem({
  node,
  depth,
  activePath,
  expanded,
  forceExpanded,
  onToggle,
  onOpen,
  changeByPath,
}: {
  node: IdeFileTreeNode;
  depth: number;
  activePath: string | null;
  expanded: ReadonlySet<string>;
  forceExpanded: boolean;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
  changeByPath: ReadonlyMap<string, CodexFileChange>;
}) {
  const isDirectory = node.kind === "directory";
  const isExpanded = forceExpanded || expanded.has(node.path);
  const style = { "--ide-tree-depth": depth } as CSSProperties;
  const fileChange = node.kind === "file" ? changeByPath.get(node.path) : undefined;

  return (
    <div
      className="ide-tree-item"
      role="treeitem"
      aria-expanded={isDirectory ? isExpanded : undefined}
    >
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
        {fileChange ? (
          <span
            className={`ide-tree-change ide-tree-change-${fileChange.kind}`}
            aria-label={
              fileChange.kind === "added"
                ? "新增文件"
                : fileChange.kind === "deleted"
                  ? "删除文件"
                  : fileChange.kind === "renamed"
                    ? "重命名文件"
                    : "修改文件"
            }
          >
            {fileChange.kind === "added"
              ? "A"
              : fileChange.kind === "deleted"
                ? "D"
                : fileChange.kind === "renamed"
                  ? "R"
                  : "M"}
          </span>
        ) : node.file ? (
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
              changeByPath={changeByPath}
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

export function IdeExplorer({
  fileCount,
  loading,
  query,
  visibleTree,
  activePath,
  expandedDirectories,
  fileChanges,
  forceExpanded,
  onQueryChange,
  onToggleDirectory,
  onOpenFile,
}: IdeExplorerProps) {
  const changeByPath = useMemo(() => {
    const result = new Map<string, CodexFileChange>();
    for (const change of fileChanges) result.set(change.path.replaceAll("\\", "/"), change);
    return result;
  }, [fileChanges]);
  return (
    <aside className="ide-explorer" aria-label="文件资源管理器">
      <div className="ide-pane-heading">
        <strong>资源管理器</strong>
        <Badge appearance="tint">{fileCount}</Badge>
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
        {loading && fileCount === 0 ? <ExplorerSkeleton /> : null}
        {!loading && fileCount === 0 ? (
          <div className="ide-state ide-state-compact">
            <FolderOpenRegular aria-hidden="true" />
            <strong>没有可共享的文本文件</strong>
            <span>同步工作区后，安全范围内的文件会显示在这里。</span>
          </div>
        ) : null}
        {fileCount > 0 && visibleTree.length === 0 ? (
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
            expanded={expandedDirectories}
            forceExpanded={forceExpanded}
            onToggle={onToggleDirectory}
            onOpen={onOpenFile}
            changeByPath={changeByPath}
            key={node.id}
          />
        ))}
      </div>
    </aside>
  );
}
