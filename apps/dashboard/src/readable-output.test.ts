import { describe, expect, it } from "vitest";
import { parseReadableBlocks, presentExecutionEntry } from "./readable-output.js";

describe("parseReadableBlocks", () => {
  it("turns common Markdown into readable blocks", () => {
    expect(
      parseReadableBlocks(
        [
          "## 完成结果",
          "",
          "已经修复实时同步。",
          "",
          "- 过程每秒更新",
          "- 长输出可以展开",
          "",
          "```ts",
          "const ready = true;",
          "```",
        ].join("\n"),
      ),
    ).toEqual([
      { kind: "heading", level: 2, text: "完成结果" },
      { kind: "paragraph", text: "已经修复实时同步。" },
      {
        kind: "unordered-list",
        items: ["过程每秒更新", "长输出可以展开"],
      },
      {
        kind: "code",
        language: "ts",
        text: "const ready = true;",
      },
    ]);
  });
});

describe("presentExecutionEntry", () => {
  it("presents an in-progress command separately from its future output", () => {
    expect(
      presentExecutionEntry({
        id: "call-1",
        role: "command",
        text: [
          "tool: exec_command",
          "status: running",
          "input:",
          '{"cmd":"npm test"}',
        ].join("\n"),
        createdAt: null,
      }),
    ).toMatchObject({
      title: "运行命令",
      status: "running",
      input: "$ npm test",
      output: null,
    });
  });

  it("marks a non-zero command output as failed", () => {
    expect(
      presentExecutionEntry({
        id: "call-2",
        role: "command",
        text: [
          "tool: exec_command",
          "status: completed",
          "input:",
          '{"cmd":"npm test"}',
          "output:",
          '{"output":"failed","exit_code":1}',
        ].join("\n"),
        createdAt: null,
      }),
    ).toMatchObject({
      status: "failed",
      summary: "执行失败，退出码 1",
      output: "failed\n\n退出码：1",
      outputLineCount: 3,
    });
  });
});
