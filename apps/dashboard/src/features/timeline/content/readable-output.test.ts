import { describe, expect, it } from "vitest";
import {
  classifyReadableSource,
  executionOutputNeedsViewport,
  parseReadableBlocks,
  presentExecutionEntries,
  presentExecutionEntry,
} from "./readable-output.js";

describe("executionOutputNeedsViewport", () => {
  it("uses a fixed scroll viewport for many lines or very long single lines", () => {
    expect(executionOutputNeedsViewport(Array.from({ length: 13 }, (_, index) => `line ${index}`).join("\n"))).toBe(true);
    expect(executionOutputNeedsViewport(`header\n${"x".repeat(24_908)}\nfooter`)).toBe(true);
  });

  it("keeps short output at its natural height", () => {
    expect(executionOutputNeedsViewport("build complete\nexit code: 0")).toBe(false);
    expect(executionOutputNeedsViewport(null)).toBe(false);
  });
});

describe("classifyReadableSource", () => {
  it("keeps Markdown summaries semantic instead of showing their markers", () => {
    expect(
      classifyReadableSource(
        "**Investigating relay DNS**\n**Planning stable routing**",
      ),
    ).toBe("markdown");
  });

  it("recognizes unfenced source code while leaving fenced code to Markdown", () => {
    expect(classifyReadableSource("const ready = true;\nconsole.log(ready);"))
      .toBe("code");
    expect(
      classifyReadableSource("const label = `ready`;\nconsole.log(label);"),
    ).toBe("code");
    expect(classifyReadableSource("// prepare request\nconst ready = true;"))
      .toBe("code");
    expect(classifyReadableSource('export { helper } from "../helper.js";'))
      .toBe("code");
    expect(classifyReadableSource('export * from "../helper.js";'))
      .toBe("code");
    expect(classifyReadableSource("```ts\nconst ready = true;\n```"))
      .toBe("markdown");
  });

  it("does not confuse English reasoning with declarations", () => {
    expect(classifyReadableSource("Type checking remains active while the server restarts."))
      .toBe("markdown");
    expect(classifyReadableSource("Class names need review before deployment."))
      .toBe("markdown");
    expect(classifyReadableSource("Function behavior remains unchanged."))
      .toBe("markdown");
    expect(classifyReadableSource("Import handling remains unchanged after the update."))
      .toBe("markdown");
    expect(classifyReadableSource("Import the helper from the shared module."))
      .toBe("markdown");
  });
});

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

  it("accepts standard Markdown indentation for fenced code", () => {
    expect(parseReadableBlocks("   ```ts\nconst ready = true;\n   ```"))
      .toEqual([
        {
          kind: "code",
          language: "ts",
          text: "const ready = true;",
        },
      ]);
  });
});

describe("presentExecutionEntry", () => {
  it("keeps English reasoning as an expandable source behind a Chinese summary", () => {
    expect(
      presentExecutionEntry({
        id: "reasoning-1",
        role: "reasoning",
        text: "Planning session cleanup by name prefix",
        createdAt: null,
      }),
    ).toMatchObject({
      status: "completed",
      input: "Codex 已完成本阶段的分析与计划。",
      sourceText: "Planning session cleanup by name prefix",
    });
  });

  it("marks the latest reasoning step as active while Codex is running", () => {
    expect(
      presentExecutionEntries(
        [
          {
            id: "reasoning-2",
            role: "reasoning",
            text: "Analyzing invite reuse behavior",
            createdAt: null,
          },
        ],
        true,
      )[0],
    ).toMatchObject({
      status: "running",
      summary: "Codex 正在处理",
      input: "Codex 正在分析当前任务并规划下一步。",
      sourceText: "Analyzing invite reuse behavior",
    });
  });

  it("closes stale running records after a final answer boundary", () => {
    expect(
      presentExecutionEntries(
        [
          {
            id: "stale-running",
            role: "command",
            text: [
              "tool: exec_command",
              "status: running",
              "input:",
              '{"cmd":"npm test"}',
            ].join("\n"),
            createdAt: "2026-07-26T00:00:00.000Z",
          },
        ],
        true,
        true,
      )[0],
    ).toMatchObject({
      status: "completed",
      summary: "任务完成时该步骤已结束",
    });
  });

  it("marks unresolved steps as stopped after their task is no longer active", () => {
    expect(
      presentExecutionEntries([
        {
          id: "stopped-command",
          role: "command",
          text: [
            "tool: exec",
            "status: completed",
            "input:",
            'const result = await tools.exec_command({"cmd":"npm run package:desktop"});',
            "output:",
            "Script running with cell ID 42",
            "Wall time 11.0 seconds",
          ].join("\n"),
          createdAt: "2026-07-30T00:00:00.000Z",
        },
      ])[0],
    ).toMatchObject({
      status: "stopped",
      summary: "任务已停止，该步骤未收到完成结果",
      output: "该后台步骤已随任务停止\n\n耗时：11.0 秒",
    });
  });

  it("keeps only the current final step running in an active task", () => {
    const records = presentExecutionEntries(
      [
        {
          id: "old-command",
          role: "command",
          text: "tool: exec_command\nstatus: running\ninput:\n{\"cmd\":\"npm test\"}",
          createdAt: null,
        },
        {
          id: "current-command",
          role: "command",
          text: "tool: exec_command\nstatus: running\ninput:\n{\"cmd\":\"npm run build\"}",
          createdAt: null,
        },
      ],
      true,
    );

    expect(records.map((record) => record.status)).toEqual([
      "stopped",
      "running",
    ]);
    expect(records[0]?.summary).toBe("后续步骤已继续，该步骤不再运行");
  });

  it("presents commentary as a readable processing update", () => {
    expect(
      presentExecutionEntry({
        id: "commentary-1",
        role: "assistant",
        phase: "commentary",
        text: "正在核对桌面端记录。",
        createdAt: null,
      }),
    ).toMatchObject({
      role: "commentary",
      title: "处理进展",
      status: "completed",
      input: "正在核对桌面端记录。",
    });
  });

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
      title: "运行测试",
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

  it("names a safe apply_patch summary after the edited file", () => {
    const presented = presentExecutionEntry({
      id: "patch-1",
      role: "command",
      text: [
        "tool: apply_patch",
        "status: completed",
        "input:",
        "修改 E:\\Project\\App.tsx（+3 -1）",
      ].join("\n"),
      createdAt: null,
    });

    expect(presented).toMatchObject({
      title: "编辑 App.tsx",
      input: "修改 E:\\Project\\App.tsx（+3 -1）",
    });
  });

  it("turns an orchestrated file read into a compact client-style step", () => {
    const presented = presentExecutionEntry({
      id: "call-3",
      role: "command",
      text: [
        "tool: exec",
        "status: completed",
        "input:",
        'const r = await tools.exec_command({"cmd":"Get-Content -LiteralPath \'C:\\\\Users\\\\21497\\\\.codex\\\\skills\\\\github\\\\SKILL.md\' -Raw","workdir":"E:\\\\Codex-Collab"}); text(r.output);',
        "output:",
        "Script completed",
        "Wall time 0.8 seconds",
        "Output:",
        "",
        JSON.stringify({
          chunk_id: "chunk-1",
          exit_code: 0,
          wall_time_seconds: 0.8,
          output: "---\nname: github-publish\n---\n",
        }),
      ].join("\n"),
      createdAt: null,
    });

    expect(presented).toMatchObject({
      title: "读取 SKILL.md",
      status: "completed",
      input:
        "$ Get-Content -LiteralPath 'C:\\Users\\21497\\.codex\\skills\\github\\SKILL.md' -Raw",
      output: "---\nname: github-publish\n---\n\n退出码：0\n\n耗时：0.8 秒",
    });
    expect(presented.output).not.toContain("chunk_id");
    expect(presented.output).not.toContain("\\n");
  });

  it("does not expose unrecognized internal orchestration source", () => {
    expect(
      presentExecutionEntry({
        id: "call-4",
        role: "command",
        text: [
          "tool: exec",
          "status: completed",
          "input:",
          "const internal = composePrivateToolProtocol();",
        ].join("\n"),
        createdAt: null,
      }),
    ).toMatchObject({
      title: "运行命令",
      input: null,
    });
  });

  it("parses the direct command result format used by Codex", () => {
    expect(
      presentExecutionEntry({
        id: "call-5",
        role: "command",
        text: [
          "tool: exec_command",
          "status: completed",
          "input:",
          '{"cmd":"npm test"}',
          "output:",
          "Chunk ID: test-1",
          "Wall time: 1.4 seconds",
          "Process exited with code 1",
          "Final output:",
          "1 test failed",
        ].join("\n"),
        createdAt: null,
      }),
    ).toMatchObject({
      title: "运行测试",
      status: "failed",
      summary: "执行失败，退出码 1",
      output: "1 test failed\n\n退出码：1\n\n耗时：1.4 秒",
    });
  });

  it("shows a running cell without exposing its internal identifier", () => {
    const presented = presentExecutionEntry({
      id: "call-6",
      role: "command",
      text: [
        "tool: exec",
        "status: completed",
        "input:",
        'const tasks = await Promise.all([tools.exec_command({"cmd":"npm test"}), tools.exec_command({"cmd":"npm run build"})]);',
        "output:",
        "Script running with cell ID 657",
        "Wall time 11.0 seconds",
      ].join("\n"),
      createdAt: null,
    });

    expect(presented).toMatchObject({
      title: "运行测试",
      status: "running",
      input: "$ npm test\n\n$ npm run build",
      output: "后台任务仍在运行，结果会继续同步\n\n耗时：11.0 秒",
    });
    expect(presented.output).not.toContain("657");
  });

  it("unwraps a double-encoded command result", () => {
    const nested = JSON.stringify(
      JSON.stringify({ output: "build complete", exit_code: 0 }),
    );
    expect(
      presentExecutionEntry({
        id: "call-7",
        role: "command",
        text: [
          "tool: exec_command",
          "status: completed",
          "input:",
          '{"cmd":"npm run build"}',
          "output:",
          nested,
        ].join("\n"),
        createdAt: null,
      }),
    ).toMatchObject({
      title: "构建项目",
      status: "completed",
      output: "build complete\n\n退出码：0",
    });
  });
});
