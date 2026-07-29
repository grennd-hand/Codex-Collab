import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  IdeFileChanges,
  getIdeFileChangePresentation,
  navigationTargetForFileChange,
  summarizeIdeFileChanges,
  type IdeFileChange,
} from "./IdeFileChanges.js";

const changes: IdeFileChange[] = [
  { operationId: "add", path: "src/new-file.ts", kind: "added", lifecycle: "completed", additions: 12, deletions: 0 },
  {
    operationId: "modify",
    path: "src/existing.ts",
    kind: "modified",
    lifecycle: "completed",
    additions: 5,
    deletions: 3,
    diff: {
      format: "unified",
      text: "@@ -1 +1 @@\n-old\n+new",
      truncated: true,
    },
  },
  { operationId: "delete", path: "legacy.ts", kind: "deleted", lifecycle: "completed", additions: 0, deletions: 9 },
];

describe("IdeFileChanges", () => {
  it("summarizes safe addition and deletion counts", () => {
    expect(
      summarizeIdeFileChanges([
        ...changes,
        { operationId: "invalid", path: "invalid.ts", kind: "modified", lifecycle: "completed", additions: Number.NaN, deletions: -4 },
      ]),
    ).toEqual({ files: 4, additions: 17, deletions: 12 });
  });

  it("maps added, modified, and deleted files to Codex-style status codes", () => {
    expect(getIdeFileChangePresentation("added")).toEqual({ code: "A", label: "新增" });
    expect(getIdeFileChangePresentation("modified")).toEqual({ code: "M", label: "修改" });
    expect(getIdeFileChangePresentation("deleted")).toEqual({ code: "D", label: "删除" });
    expect(getIdeFileChangePresentation("renamed")).toEqual({ code: "R", label: "重命名" });
  });

  it("prefers the structured range when navigating to a file change", () => {
    expect(
      navigationTargetForFileChange({
        ...changes[1]!,
        line: 2,
        column: 3,
        range: {
          startLine: 10,
          startColumn: 4,
          endLine: 12,
          endColumn: 8,
        },
      }),
    ).toEqual({
      path: "src/existing.ts",
      line: 10,
      column: 4,
      endLine: 12,
      endColumn: 8,
    });
  });

  it("renders a collapsible summary, file open targets, and expandable statistics", () => {
    const markup = renderToStaticMarkup(
      createElement(IdeFileChanges, {
        changes,
        activePath: "src/existing.ts",
        defaultExpandedFilePaths: ["src/existing.ts"],
        onOpenFile: vi.fn(),
      }),
    );

    expect(markup).toContain("3 个文件");
    expect(markup).toContain("+17");
    expect(markup).toContain("-12");
    expect(markup).toContain('data-change-kind="added"');
    expect(markup).toContain('data-change-kind="modified"');
    expect(markup).toContain('data-change-kind="deleted"');
    expect(markup).toContain('title="打开 src/existing.ts"');
    expect(markup).toContain("legacy.ts 已删除，无法打开当前版本");
    expect(markup).toContain("src/existing.ts 的变更预览");
    expect(markup).toContain("+5 新增");
    expect(markup).toContain("-3 删除");
    expect(markup).toContain("状态：修改");
    expect(markup).toContain('data-diff-line="deletion"');
    expect(markup).toContain('data-diff-line="addition"');
    expect(markup).toContain("预览已截断");
  });

  it("can render the entire change section collapsed", () => {
    const markup = renderToStaticMarkup(
      createElement(IdeFileChanges, {
        changes,
        defaultExpanded: false,
        onOpenFile: vi.fn(),
      }),
    );

    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("hidden=\"\"");
  });

  it("keeps completed-task file summaries compact until more files are requested", () => {
    const markup = renderToStaticMarkup(
      createElement(IdeFileChanges, {
        changes,
        initialVisibleCount: 2,
        onOpenFile: vi.fn(),
      }),
    );

    expect(markup).toContain("3 个文件");
    expect(markup).toContain("src/new-file.ts");
    expect(markup).toContain("src/existing.ts");
    expect(markup).not.toContain("legacy.ts 已删除");
    expect(markup).toContain("再显示 1 个文件");
    expect(markup).toContain('aria-expanded="false"');
  });
});
