import {
  ChevronDownRegular,
  ChevronRightRegular,
  DocumentRegular,
  FolderOpenRegular,
  FolderRegular,
} from "@fluentui/react-icons";
import type { CodexFileChange } from "@codex-collab/protocol";
import type { CSSProperties } from "react";
import type { IdeFileTreeNode } from "./file-tree.js";
import type {
  IdeTreeSelection,
  PendingIdeCreate,
} from "./ide-create-entry.js";
import { IdeInlineCreateRow } from "./IdeInlineCreateRow.js";
import { IdeInlineRenameRow } from "./IdeInlineRenameRow.js";

interface IdeExplorerTreeProps {
  nodes: readonly IdeFileTreeNode[];
  selectedPath: string | null;
  expanded: ReadonlySet<string>;
  forceExpanded: boolean;
  changeByPath: ReadonlyMap<string, CodexFileChange>;
  pendingCreate: PendingIdeCreate | null;
  pendingRename: IdeTreeSelection | null;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
  onSelect: (selection: IdeTreeSelection) => void;
  onCancelCreate: () => void;
  onCommitCreate: (path: string) => Promise<void>;
  onStartRename: (entry: IdeTreeSelection) => void;
  onCancelRename: () => void;
  onCommitRename: (entry: IdeTreeSelection, destinationPath: string) => Promise<void>;
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function changeLabel(kind: CodexFileChange["kind"]): string {
  if (kind === "added") return "新增文件";
  if (kind === "deleted") return "删除文件";
  if (kind === "renamed") return "重命名文件";
  return "修改文件";
}

function changeToken(kind: CodexFileChange["kind"]): string {
  if (kind === "added") return "A";
  if (kind === "deleted") return "D";
  if (kind === "renamed") return "R";
  return "M";
}

type TreeItemProps = Omit<IdeExplorerTreeProps, "nodes"> & {
  node: IdeFileTreeNode;
  depth: number;
};

function TreeItem({
  node,
  depth,
  selectedPath,
  expanded,
  forceExpanded,
  changeByPath,
  pendingCreate,
  pendingRename,
  onToggle,
  onOpen,
  onSelect,
  onCancelCreate,
  onCommitCreate,
  onStartRename,
  onCancelRename,
  onCommitRename,
}: TreeItemProps) {
  const isDirectory = node.kind === "directory";
  const isExpanded =
    forceExpanded ||
    expanded.has(node.path) ||
    pendingCreate?.parentPath === node.path;
  const style = { "--ide-tree-depth": depth } as CSSProperties;
  const fileChange = node.kind === "file" ? changeByPath.get(node.path) : undefined;
  const renaming = pendingRename?.path === node.path;

  return (
    <div
      className="ide-tree-item"
      role={renaming ? undefined : "treeitem"}
      aria-expanded={!renaming && isDirectory ? isExpanded : undefined}
    >
      {renaming ? (
        <IdeInlineRenameRow
          entry={pendingRename}
          name={node.name}
          depth={depth}
          onCancel={onCancelRename}
          onRename={onCommitRename}
        />
      ) : (
        <button
          type="button"
          className={`ide-tree-row ${selectedPath === node.path ? "active" : ""}`}
          style={style}
          title={node.path}
          onClick={() => {
            onSelect({ path: node.path, kind: node.kind });
            if (isDirectory) onToggle(node.path);
            else onOpen(node.path);
          }}
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onStartRename({ path: node.path, kind: node.kind });
          }}
          onKeyDown={(event) => {
            if (event.key !== "F2") return;
            event.preventDefault();
            onStartRename({ path: node.path, kind: node.kind });
          }}
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
            aria-label={changeLabel(fileChange.kind)}
          >
            {changeToken(fileChange.kind)}
          </span>
        ) : node.file ? (
          <span className="ide-tree-size">{formatFileSize(node.file.size)}</span>
        ) : null}
        </button>
      )}
      {isDirectory && isExpanded ? (
        <div role="group">
          {pendingCreate?.parentPath === node.path ? (
            <IdeInlineCreateRow
              key={pendingCreate.id}
              kind={pendingCreate.kind}
              parentPath={pendingCreate.parentPath}
              depth={depth + 1}
              onCancel={onCancelCreate}
              onCreate={onCommitCreate}
            />
          ) : null}
          {node.children.map((child) => (
            <TreeItem
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              expanded={expanded}
              forceExpanded={forceExpanded}
              changeByPath={changeByPath}
              pendingCreate={pendingCreate}
              pendingRename={pendingRename}
              onToggle={onToggle}
              onOpen={onOpen}
              onSelect={onSelect}
              onCancelCreate={onCancelCreate}
              onCommitCreate={onCommitCreate}
              onStartRename={onStartRename}
              onCancelRename={onCancelRename}
              onCommitRename={onCommitRename}
              key={child.id}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function IdeExplorerTree(props: IdeExplorerTreeProps) {
  const { nodes, ...treeProps } = props;
  return (
    <>
      {props.pendingCreate?.parentPath === "" ? (
        <IdeInlineCreateRow
          key={props.pendingCreate.id}
          kind={props.pendingCreate.kind}
          parentPath=""
          depth={0}
          onCancel={props.onCancelCreate}
          onCreate={props.onCommitCreate}
        />
      ) : null}
      {nodes.map((node) => (
        <TreeItem {...treeProps} node={node} depth={0} key={node.id} />
      ))}
    </>
  );
}
