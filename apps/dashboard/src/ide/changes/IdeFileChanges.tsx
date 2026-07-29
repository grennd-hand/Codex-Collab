import {
  ChevronDownRegular,
  ChevronRightRegular,
} from "@fluentui/react-icons";
import type { CodexFileChange } from "@codex-collab/protocol";
import { useId, useMemo, useState } from "react";
import type { IdeNavigationTarget } from "../state/types.js";
import { IdeUnifiedDiff } from "../editor/IdeUnifiedDiff.js";
import "./ide-file-changes.css";

export type IdeFileChangeKind = CodexFileChange["kind"];
export type IdeFileChange = CodexFileChange;

export interface IdeFileChangeSummary {
  files: number;
  additions: number;
  deletions: number;
}

export interface IdeFileChangesProps {
  changes: readonly IdeFileChange[];
  activePath?: string | null;
  title?: string;
  expanded?: boolean;
  defaultExpanded?: boolean;
  initialVisibleCount?: number;
  expandedFilePaths?: ReadonlySet<string>;
  defaultExpandedFilePaths?: readonly string[];
  className?: string;
  onExpandedChange?: (expanded: boolean) => void;
  onFileExpandedChange?: (path: string, expanded: boolean) => void;
  onOpenFile?: (path: string, change: IdeFileChange) => void;
}

const CHANGE_PRESENTATION: Record<
  IdeFileChangeKind,
  { code: "A" | "M" | "D" | "R"; label: string }
> = {
  added: { code: "A", label: "新增" },
  modified: { code: "M", label: "修改" },
  deleted: { code: "D", label: "删除" },
  renamed: { code: "R", label: "重命名" },
};

function safeLineCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function splitDisplayPath(path: string): { name: string; parent: string } {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  return {
    name: parts.at(-1) ?? path,
    parent: parts.length > 1 ? parts.slice(0, -1).join("/") : "项目根目录",
  };
}

export function getIdeFileChangePresentation(kind: IdeFileChangeKind) {
  return CHANGE_PRESENTATION[kind];
}

export function summarizeIdeFileChanges(
  changes: readonly IdeFileChange[],
): IdeFileChangeSummary {
  return changes.reduce<IdeFileChangeSummary>(
    (summary, change) => ({
      files: summary.files + 1,
      additions: summary.additions + safeLineCount(change.additions),
      deletions: summary.deletions + safeLineCount(change.deletions),
    }),
    { files: 0, additions: 0, deletions: 0 },
  );
}

export function navigationTargetForFileChange(
  change: IdeFileChange,
): IdeNavigationTarget {
  const range = change.range;
  return {
    path: change.path,
    ...(range
      ? {
          line: range.startLine,
          column: range.startColumn,
          endLine: range.endLine,
          endColumn: range.endColumn,
        }
      : {
          ...(change.line ? { line: change.line } : {}),
          ...(change.column ? { column: change.column } : {}),
        }),
  };
}

export function IdeFileChanges({
  changes,
  activePath = null,
  title = "文件更改",
  expanded,
  defaultExpanded = true,
  initialVisibleCount,
  expandedFilePaths,
  defaultExpandedFilePaths = [],
  className,
  onExpandedChange,
  onFileExpandedChange,
  onOpenFile,
}: IdeFileChangesProps) {
  const [localExpanded, setLocalExpanded] = useState(defaultExpanded);
  const [localExpandedPaths, setLocalExpandedPaths] = useState<Set<string>>(
    () => new Set(defaultExpandedFilePaths),
  );
  const [showAllChanges, setShowAllChanges] = useState(false);
  const contentId = useId();
  const isExpanded = expanded ?? localExpanded;
  const visibleExpandedPaths = expandedFilePaths ?? localExpandedPaths;
  const summary = useMemo(() => summarizeIdeFileChanges(changes), [changes]);
  const visibleLimit =
    initialVisibleCount === undefined || !Number.isFinite(initialVisibleCount)
      ? changes.length
      : Math.max(1, Math.trunc(initialVisibleCount));
  const visibleChanges = showAllChanges ? changes : changes.slice(0, visibleLimit);
  const hiddenChangeCount = Math.max(0, changes.length - visibleLimit);

  const changeSectionExpanded = (nextExpanded: boolean) => {
    if (expanded === undefined) {
      setLocalExpanded(nextExpanded);
    }
    onExpandedChange?.(nextExpanded);
  };

  const changeFileExpanded = (path: string, nextExpanded: boolean) => {
    if (expandedFilePaths === undefined) {
      setLocalExpandedPaths((current) => {
        const next = new Set(current);
        if (nextExpanded) next.add(path);
        else next.delete(path);
        return next;
      });
    }
    onFileExpandedChange?.(path, nextExpanded);
  };

  return (
    <section
      className={["ide-file-changes", className].filter(Boolean).join(" ")}
      aria-label={title}
    >
      <button
        type="button"
        className="ide-file-changes-summary"
        aria-expanded={isExpanded}
        aria-controls={contentId}
        onClick={() => changeSectionExpanded(!isExpanded)}
      >
        <span className="ide-file-changes-chevron" aria-hidden="true">
          {isExpanded ? <ChevronDownRegular /> : <ChevronRightRegular />}
        </span>
        <strong>{title}</strong>
        <span className="ide-file-changes-count">
          {summary.files} 个文件
        </span>
        <span className="ide-file-changes-totals" aria-label="变更行数">
          <span className="ide-change-additions">+{summary.additions}</span>
          <span className="ide-change-deletions">-{summary.deletions}</span>
        </span>
      </button>

      <div id={contentId} hidden={!isExpanded} className="ide-file-changes-list">
        {changes.length === 0 ? (
          <div className="ide-file-changes-empty">当前没有文件更改</div>
        ) : null}
        {visibleChanges.map((change) => {
          const presentation = CHANGE_PRESENTATION[change.kind];
          const displayPath = splitDisplayPath(change.path);
          const fileExpanded = visibleExpandedPaths.has(change.path);
          const detailsId = `${contentId}-${change.path.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

          return (
            <div
              className={`ide-file-change ide-file-change-${change.kind}`}
              data-change-kind={change.kind}
              key={change.operationId}
            >
              <div className="ide-file-change-row">
                <span
                  className="ide-file-change-kind"
                  aria-label={presentation.label}
                  title={presentation.label}
                >
                  {presentation.code}
                </span>
                <button
                  type="button"
                  className={`ide-file-change-open ${activePath === change.path ? "active" : ""}`}
                  title={
                    change.kind === "deleted"
                      ? `${change.path} 已删除，无法打开当前版本`
                      : `打开 ${change.path}`
                  }
                  disabled={change.kind === "deleted" || !onOpenFile}
                  onClick={() => onOpenFile?.(change.path, change)}
                >
                  <span className="ide-file-change-name">{displayPath.name}</span>
                  <span className="ide-file-change-parent">{displayPath.parent}</span>
                </button>
                <button
                  type="button"
                  className="ide-file-change-disclosure"
                  aria-label={`${fileExpanded ? "收起" : "展开"} ${change.path} 的变更预览`}
                  aria-expanded={fileExpanded}
                  aria-controls={detailsId}
                  onClick={() => changeFileExpanded(change.path, !fileExpanded)}
                >
                  {fileExpanded ? <ChevronDownRegular /> : <ChevronRightRegular />}
                </button>
              </div>

              <div
                id={detailsId}
                hidden={!fileExpanded}
                className="ide-file-change-details"
              >
                <div className="ide-file-change-stats">
                  <span className="ide-change-additions">
                    +{safeLineCount(change.additions)} 新增
                  </span>
                  <span className="ide-change-deletions">
                    -{safeLineCount(change.deletions)} 删除
                  </span>
                  <span className="ide-file-change-kind-label">
                    状态：{presentation.label}
                  </span>
                </div>
                <IdeUnifiedDiff diff={change.diff} />
              </div>
            </div>
          );
        })}
        {hiddenChangeCount > 0 ? (
          <button
            type="button"
            className="ide-file-changes-more"
            aria-expanded={showAllChanges}
            onClick={() => setShowAllChanges((current) => !current)}
          >
            {showAllChanges
              ? `收起 ${hiddenChangeCount} 个文件`
              : `再显示 ${hiddenChangeCount} 个文件`}
            <span aria-hidden="true">
              {showAllChanges ? <ChevronDownRegular /> : <ChevronRightRegular />}
            </span>
          </button>
        ) : null}
      </div>
    </section>
  );
}
