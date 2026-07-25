import type { CodexRecordEntry } from "@codex-collab/protocol";

export type ReadableBlock =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "unordered-list"; items: string[] }
  | { kind: "ordered-list"; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "code"; language: string | null; text: string };

export type ExecutionStatus = "running" | "completed" | "failed" | "unknown";

export interface ReadableExecution {
  id: string;
  role: "reasoning" | "command";
  title: string;
  status: ExecutionStatus;
  summary: string;
  input: string | null;
  output: string | null;
  outputLineCount: number;
  createdAt: string | null;
}

function isBlockStart(line: string): boolean {
  return (
    /^#{1,3}\s+/.test(line) ||
    /^[-*]\s+/.test(line) ||
    /^\d+[.)]\s+/.test(line) ||
    /^>\s?/.test(line) ||
    /^```/.test(line)
  );
}

export function parseReadableBlocks(text: string): ReadableBlock[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReadableBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^```\s*([^\s`]*)\s*$/);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? "")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({
        kind: "code",
        language: fence[1] || null,
        text: code.join("\n"),
      });
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1]!.length as 1 | 2 | 3,
        text: heading[2]!.trim(),
      });
      index += 1;
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = (lines[index] ?? "").match(/^[-*]\s+(.+)$/);
        if (!item) break;
        items.push(item[1]!.trim());
        index += 1;
      }
      blocks.push({ kind: "unordered-list", items });
      continue;
    }

    if (/^\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = (lines[index] ?? "").match(/^\d+[.)]\s+(.+)$/);
        if (!item) break;
        items.push(item[1]!.trim());
        index += 1;
      }
      blocks.push({ kind: "ordered-list", items });
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length) {
        const item = (lines[index] ?? "").match(/^>\s?(.*)$/);
        if (!item) break;
        quote.push(item[1] ?? "");
        index += 1;
      }
      blocks.push({ kind: "quote", text: quote.join("\n").trim() });
      continue;
    }

    const paragraph: string[] = [line.trim()];
    index += 1;
    while (
      index < lines.length &&
      (lines[index] ?? "").trim() &&
      !isBlockStart(lines[index] ?? "")
    ) {
      paragraph.push((lines[index] ?? "").trim());
      index += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
  }

  return blocks;
}

function commandTitle(tool: string): string {
  switch (tool) {
    case "exec":
    case "exec_command":
      return "运行命令";
    case "apply_patch":
      return "修改文件";
    case "write_stdin":
      return "继续运行命令";
    default:
      return tool ? `执行 ${tool}` : "执行操作";
  }
}

function extractExitCode(output: string): number | null {
  const match =
    output.match(/"exit_code"\s*:\s*(-?\d+)/i) ??
    output.match(/\bexit[\s_-]*code\s*:\s*(-?\d+)/i);
  return match?.[1] === undefined ? null : Number(match[1]);
}

function friendlyCommandInput(tool: string, input: string | null): string | null {
  if (!input) return null;
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    if (typeof parsed.cmd === "string") {
      return [
        `$ ${parsed.cmd}`,
        typeof parsed.workdir === "string" ? `目录：${parsed.workdir}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }
    if (tool === "write_stdin" && typeof parsed.chars === "string") {
      return parsed.chars ? `发送输入：${parsed.chars}` : "检查命令的最新输出";
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return input;
  }
}

function friendlyCommandOutput(output: string | null): string | null {
  if (!output) return null;
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const content = typeof parsed.output === "string" ? parsed.output.trim() : "";
    const exitCode =
      typeof parsed.exit_code === "number" ? parsed.exit_code : null;
    const duration =
      typeof parsed.wall_time_seconds === "number"
        ? `${parsed.wall_time_seconds.toFixed(1)} 秒`
        : null;
    if (!content && exitCode === null && duration === null) {
      return JSON.stringify(parsed, null, 2);
    }
    return [
      content,
      exitCode === null ? "" : `退出码：${exitCode}`,
      duration ? `耗时：${duration}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  } catch {
    return output;
  }
}

function executionSummary(
  status: ExecutionStatus,
  output: string | null,
): string {
  if (status === "running") return "正在执行，结果返回后会自动更新";
  const exitCode = output ? extractExitCode(output) : null;
  if (status === "failed") {
    return exitCode === null ? "执行失败，请展开输出查看原因" : `执行失败，退出码 ${exitCode}`;
  }
  if (status === "completed") {
    return exitCode === null ? "执行完成" : `执行完成，退出码 ${exitCode}`;
  }
  return "已记录执行过程";
}

function parseTaggedCommand(text: string): {
  tool: string;
  status: ExecutionStatus;
  input: string | null;
  output: string | null;
} | null {
  const normalized = text.replace(/\r\n?/g, "\n");
  const header = normalized.match(
    /^tool:\s*([^\n]+)\nstatus:\s*(running|completed|failed)\n?/,
  );
  if (!header) return null;
  const remainder = normalized.slice(header[0].length);
  const outputMarker = remainder.indexOf("\noutput:\n");
  const inputMarker = remainder.startsWith("input:\n");
  const inputStart = inputMarker ? "input:\n".length : 0;
  const input =
    outputMarker >= 0
      ? remainder.slice(inputStart, outputMarker).trim()
      : inputMarker
        ? remainder.slice(inputStart).trim()
        : null;
  const output =
    outputMarker >= 0
      ? remainder.slice(outputMarker + "\noutput:\n".length).trim()
      : remainder.startsWith("output:\n")
        ? remainder.slice("output:\n".length).trim()
        : null;
  const exitCode = output ? extractExitCode(output) : null;
  return {
    tool: header[1]!.trim(),
    status:
      exitCode !== null && exitCode !== 0
        ? "failed"
        : (header[2] as ExecutionStatus),
    input: input || null,
    output: output || null,
  };
}

function parseLegacyCommand(text: string): {
  tool: string;
  status: ExecutionStatus;
  input: string | null;
  output: string | null;
} {
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const toolLine = lines[0]?.match(/^tool:\s*(.+)$/);
  const tool = toolLine?.[1]?.trim() ?? (lines[0]?.startsWith("$ ") ? "exec_command" : "");
  const exitCode = extractExitCode(normalized);
  const status: ExecutionStatus =
    exitCode === null ? "unknown" : exitCode === 0 ? "completed" : "failed";

  if (lines[0]?.startsWith("$ ")) {
    const metaStart = lines.findIndex((line, index) => index > 0 && /^(?:cwd|exit code|duration):/.test(line));
    const outputEnd = lines.findIndex((line, index) => index > 0 && /^(?:exit code|duration):/.test(line));
    return {
      tool,
      status,
      input: lines[0].slice(2).trim() || null,
      output:
        lines
          .slice(
            metaStart === 1 && lines[1]?.startsWith("cwd:") ? 2 : 1,
            outputEnd < 0 ? lines.length : outputEnd,
          )
          .join("\n")
          .trim() || null,
    };
  }

  return {
    tool,
    status,
    input: toolLine ? lines.slice(1).join("\n").trim() || null : normalized.trim(),
    output: null,
  };
}

export function presentExecutionEntry(entry: CodexRecordEntry): ReadableExecution {
  if (entry.role === "reasoning") {
    return {
      id: entry.id,
      role: "reasoning",
      title: "分析与计划",
      status: "completed",
      summary: "Codex 的当前处理思路",
      input: entry.text,
      output: null,
      outputLineCount: 0,
      createdAt: entry.createdAt,
    };
  }

  const parsed = parseTaggedCommand(entry.text) ?? parseLegacyCommand(entry.text);
  const displayInput = friendlyCommandInput(parsed.tool, parsed.input);
  const displayOutput = friendlyCommandOutput(parsed.output);
  return {
    id: entry.id,
    role: "command",
    title: commandTitle(parsed.tool),
    status: parsed.status,
    summary: executionSummary(parsed.status, parsed.output),
    input: displayInput,
    output: displayOutput,
    outputLineCount: displayOutput ? displayOutput.split("\n").length : 0,
    createdAt: entry.createdAt,
  };
}
