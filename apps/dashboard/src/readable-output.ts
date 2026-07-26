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
  sourceText: string | null;
  outputLineCount: number;
  createdAt: string | null;
}

export interface PresentExecutionEntryOptions {
  active?: boolean;
}

export type ReadableSourceKind = "markdown" | "code";

export function classifyReadableSource(text: string): ReadableSourceKind {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return "markdown";
  const firstLine = normalized.split("\n", 1)[0] ?? "";

  // Markdown block markers on the first line take precedence, including
  // fenced code blocks that parseReadableBlocks renders semantically.
  if (/^ {0,3}(?:```|#{1,3}\s|[-*]\s|\d+[.)]\s|>\s?)/.test(firstLine)) {
    return "markdown";
  }

  if (/^[{[]/.test(normalized)) {
    try {
      JSON.parse(normalized);
      return "code";
    } catch {
      // A prose paragraph can start with a bracket, so keep checking below.
    }
  }

  const startsWithCodeSyntax = [
    /^(?:#!|\/\/|\/\*)/,
    /^import\s+(?:["'][^"'\n]+["']|(?:type\s+)?[^\n;]{1,200}\s+from\s+["'][^"'\n]+["'])/,
    /^import\s*\(/,
    /^export\s+(?:(?:default|type)\s+)?(?:const|let|var|async\s+function|function|class|interface|type|enum)\b/,
    /^export\s+(?:type\s+)?\{[^}\n]*\}(?:\s+from\s+["'][^"'\n]+["'])?\s*;?/,
    /^export\s+\*\s+from\s+["'][^"'\n]+["']\s*;?/,
    /^(?:const|let|var)\s+[$A-Z_a-z][$\w]*(?:\s*:[^=\n]+)?\s*=/,
    /^(?:async\s+)?function\s+[$A-Z_a-z][$\w]*\s*\(/,
    /^(?:abstract\s+)?class\s+[$A-Z_a-z][$\w]*(?:\s+extends\s+[^\n{]+)?\s*\{/,
    /^interface\s+[$A-Z_a-z][$\w]*(?:\s+extends\s+[^\n{]+)?\s*\{/,
    /^type\s+[$A-Z_a-z][$\w]*(?:<[^\n>]+>)?\s*=/,
    /^(?:const\s+)?enum\s+[$A-Z_a-z][$\w]*\s*\{/,
    /^namespace\s+[$A-Z_a-z][$\w.]*\s*\{/,
    /^(?:async\s+)?def\s+[A-Za-z_]\w*\s*\(/,
    /^from\s+[A-Za-z_][\w.]*\s+import\s+/,
    /^package\s+[\w.]+\s*;/,
    /^func\s+[A-Za-z_]\w*\s*\(/,
  ].some((pattern) => pattern.test(normalized));
  const startsWithCaseInsensitiveCodeSyntax =
    /^(?:(?:SELECT\s+[\s\S]+\s+FROM|INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM|CREATE\s+(?:TABLE|INDEX|VIEW)|ALTER\s+TABLE)\b|<\?xml|<!doctype\s+html|<html\b)/i.test(
      normalized,
    );
  if (startsWithCodeSyntax || startsWithCaseInsensitiveCodeSyntax) {
    return "code";
  }

  const lines = normalized.split("\n").filter((line) => line.trim());
  const codeLines = lines.filter((line) =>
    /(?:=>|===|!==|[;{}]\s*$|^\s*(?:[}\]]|\/\/?\*?|(?:const|let|var)\s+[$A-Z_a-z][$\w]*|(?:return|throw)\b|await\s+[$A-Z_a-z(]))/.test(
      line,
    ),
  );
  return lines.length >= 2 && codeLines.length >= Math.ceil(lines.length * 0.6)
    ? "code"
    : "markdown";
}

function isBlockStart(line: string): boolean {
  return (
    /^ {0,3}#{1,3}\s+/.test(line) ||
    /^ {0,3}[-*]\s+/.test(line) ||
    /^ {0,3}\d+[.)]\s+/.test(line) ||
    /^ {0,3}>\s?/.test(line) ||
    /^ {0,3}```/.test(line)
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

    const fence = line.match(/^ {0,3}```\s*([^\s`]*)\s*$/);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^ {0,3}```\s*$/.test(lines[index] ?? "")) {
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

    const heading = line.match(/^ {0,3}(#{1,3})\s+(.+)$/);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1]!.length as 1 | 2 | 3,
        text: heading[2]!.trim(),
      });
      index += 1;
      continue;
    }

    if (/^ {0,3}[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = (lines[index] ?? "").match(/^ {0,3}[-*]\s+(.+)$/);
        if (!item) break;
        items.push(item[1]!.trim());
        index += 1;
      }
      blocks.push({ kind: "unordered-list", items });
      continue;
    }

    if (/^ {0,3}\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = (lines[index] ?? "").match(/^ {0,3}\d+[.)]\s+(.+)$/);
        if (!item) break;
        items.push(item[1]!.trim());
        index += 1;
      }
      blocks.push({ kind: "ordered-list", items });
      continue;
    }

    if (/^ {0,3}>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length) {
        const item = (lines[index] ?? "").match(/^ {0,3}>\s?(.*)$/);
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

function commandTitle(tool: string, input: string | null): string {
  if (tool === "apply_patch" && input) {
    const paths = input
      .split(/\r?\n/)
      .map((line) => {
        const withoutCounts = line.replace(/（\+\d+\s+-\d+）$/, "");
        const summarized = withoutCounts
          .match(/^(?:新增|删除|修改|移动)\s+(.+)$/)?.[1]
          ?.split(/\s+→\s+/)[0];
        const patchMarker = line.match(/^\*\*\*\s+(?:Add|Update|Delete) File:\s+(.+)$/)?.[1];
        return (summarized ?? patchMarker)?.trim() ?? null;
      })
      .filter((path): path is string => Boolean(path));
    if (paths.length === 1) {
      const fileName = paths[0]!.split(/[\\/]/).filter(Boolean).at(-1);
      return fileName ? `编辑 ${fileName}` : "修改文件";
    }
    if (paths.length > 1) return `编辑 ${paths.length} 个文件`;
  }
  const rawCommand = extractCommandTexts(tool, input)[0] ?? "";
  const command = rawCommand.toLowerCase();
  if (/^(?:get-content|type\s|cat\s)/.test(command)) {
    const path = rawCommand.match(
      /(?:-LiteralPath\s+)?["']([^"']+)["']/i,
    )?.[1];
    const fileName = path?.split(/[\\/]/).filter(Boolean).at(-1);
    return fileName ? `读取 ${fileName}` : "读取文件";
  }
  if (/^(?:rg\s|select-string\s|findstr\s)/.test(command)) return "搜索内容";
  if (/^(?:npm\s+(?:run\s+)?test|npx\s+vitest|vitest\s)/.test(command)) {
    return "运行测试";
  }
  if (/^(?:npm\s+run\s+build|npx\s+vite\s+build|vite\s+build)/.test(command)) {
    return "构建项目";
  }
  if (/^git\s+(?:status|diff|log|rev-parse|rev-list|fetch)\b/.test(command)) {
    return "检查 Git 状态";
  }
  if (/^git\s+(?:add|commit|push)\b/.test(command)) return "提交代码";
  if (/^scp\s/.test(command)) return "上传文件";
  if (/^ssh\s/.test(command)) return "连接服务器";
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

function readJavaScriptString(
  source: string,
  start: number,
): { value: string; end: number } | null {
  const quote = source[start];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character !== quote) continue;
    const literal = source.slice(start, index + 1);
    if (quote === '"') {
      try {
        return { value: JSON.parse(literal) as string, end: index + 1 };
      } catch {
        return null;
      }
    }
    const body = literal.slice(1, -1);
    return {
      value: body.replace(/\\([\\'`nrt])/g, (_match, escapedCharacter: string) => {
        if (escapedCharacter === "n") return "\n";
        if (escapedCharacter === "r") return "\r";
        if (escapedCharacter === "t") return "\t";
        return escapedCharacter;
      }),
      end: index + 1,
    };
  }
  return null;
}

function extractExecCommands(source: string): string[] {
  const commands: string[] = [];
  const pattern =
    /\b(?:tools\.)?exec_command\s*\(\s*\{[\s\S]{0,600}?(?:["']cmd["']|\bcmd)\s*:\s*/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null && commands.length < 8) {
    const literal = readJavaScriptString(source, match.index + match[0].length);
    if (!literal) continue;
    commands.push(literal.value.trim());
    pattern.lastIndex = literal.end;
  }
  return commands.filter(Boolean);
}

function extractCommandTexts(tool: string, input: string | null): string[] {
  if (!input) return [];
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    if (typeof parsed.cmd === "string") return [parsed.cmd.trim()].filter(Boolean);
  } catch {
    // Custom exec calls contain JavaScript source instead of JSON arguments.
  }
  if (tool === "exec") return extractExecCommands(input);
  if (input.startsWith("$ ")) return [input.slice(2).split("\n")[0]!.trim()].filter(Boolean);
  return [];
}

function extractExitCode(output: string): number | null {
  const match =
    output.match(/"exit_code"\s*:\s*(-?\d+)/i) ??
    output.match(/\bexit[\s_-]*code\s*:\s*(-?\d+)/i) ??
    output.match(/\bprocess exited with code\s+(-?\d+)/i);
  return match?.[1] === undefined ? null : Number(match[1]);
}

function outputIndicatesRunning(output: string): boolean {
  return /^Script running with cell ID\b/i.test(output.trim());
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
    if (tool === "exec") {
      const commands = extractExecCommands(input);
      if (commands.length === 0) return null;
      return commands.map((command) => `$ ${command}`).join("\n\n");
    }
    return input;
  }
}

interface DecodedCommandOutput {
  content: string;
  exitCode: number | null;
  durationSeconds: number | null;
}

function decodeCommandOutput(value: unknown, depth = 0): DecodedCommandOutput {
  if (depth > 3) {
    return {
      content: typeof value === "string" ? value.trim() : JSON.stringify(value, null, 2),
      exitCode: null,
      durationSeconds: null,
    };
  }
  if (typeof value === "string") {
    const normalized = value.replace(/\r\n?/g, "\n").trim();
    if (outputIndicatesRunning(normalized)) {
      const duration = normalized.match(/\bWall time\s+([\d.]+)\s+seconds?/i)?.[1];
      return {
        content: "后台任务仍在运行，结果会继续同步",
        exitCode: null,
        durationSeconds: duration === undefined ? null : Number(duration),
      };
    }
    const directResult = normalized.match(
      /^(?:Chunk ID:\s*[^\n]+\n)?(?:Wall time:\s*([\d.]+)\s*seconds?\n)?Process exited with code\s+(-?\d+)\nFinal output:\s*\n?([\s\S]*)$/i,
    );
    if (directResult) {
      return {
        content: (directResult[3] ?? "").trim(),
        exitCode: Number(directResult[2]),
        durationSeconds:
          directResult[1] === undefined ? null : Number(directResult[1]),
      };
    }
    const outputMarker = normalized.match(
      /^Script (?:completed|running[^\n]*)\n(?:Wall time [^\n]+\n)?Output:\s*\n/i,
    );
    const candidate = outputMarker ? normalized.slice(outputMarker[0].length).trim() : normalized;
    if (/^[{[\"]/.test(candidate)) {
      try {
        return decodeCommandOutput(JSON.parse(candidate), depth + 1);
      } catch {
        // The command output is ordinary text that happens to start with a bracket.
      }
    }
    return { content: candidate, exitCode: null, durationSeconds: null };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { content: value == null ? "" : String(value), exitCode: null, durationSeconds: null };
  }
  const record = value as Record<string, unknown>;
  const nested =
    typeof record.output === "string"
      ? decodeCommandOutput(record.output, depth + 1)
      : { content: "", exitCode: null, durationSeconds: null };
  const exitCode = typeof record.exit_code === "number" ? record.exit_code : nested.exitCode;
  const durationSeconds =
    typeof record.wall_time_seconds === "number"
      ? record.wall_time_seconds
      : nested.durationSeconds;
  if (nested.content || exitCode !== null || durationSeconds !== null) {
    return { content: nested.content, exitCode, durationSeconds };
  }
  return { content: JSON.stringify(record, null, 2), exitCode: null, durationSeconds: null };
}

function friendlyCommandOutput(output: string | null): string | null {
  if (!output) return null;
  try {
    const decoded = decodeCommandOutput(output);
    const duration = decoded.durationSeconds === null
      ? null
      : `${decoded.durationSeconds.toFixed(1)} 秒`;
    return [
      decoded.content,
      decoded.exitCode === null ? "" : `退出码：${decoded.exitCode}`,
      duration ? `耗时：${duration}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  } catch {
    return output.replace(/\r\n?/g, "\n").trim();
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
      output && outputIndicatesRunning(output)
        ? "running"
        : exitCode !== null && exitCode !== 0
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

function reasoningDisplayText(text: string, active: boolean): {
  displayText: string;
  sourceText: string | null;
} {
  const normalized = text.trim();
  if (/\p{Script=Han}/u.test(normalized)) {
    return { displayText: normalized, sourceText: null };
  }
  return {
    displayText: active
      ? "Codex 正在分析当前任务并规划下一步。"
      : "Codex 已完成本阶段的分析与计划。",
    sourceText: normalized || null,
  };
}

export function presentExecutionEntry(
  entry: CodexRecordEntry,
  options: PresentExecutionEntryOptions = {},
): ReadableExecution {
  if (entry.role === "reasoning") {
    const active = options.active === true;
    const reasoning = reasoningDisplayText(entry.text, active);
    return {
      id: entry.id,
      role: "reasoning",
      title: "分析与计划",
      status: active ? "running" : "completed",
      summary: active ? "Codex 正在处理" : "Codex 的当前处理思路",
      input: reasoning.displayText,
      output: null,
      sourceText: reasoning.sourceText,
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
    title: commandTitle(parsed.tool, parsed.input),
    status: parsed.status,
    summary: executionSummary(parsed.status, parsed.output),
    input: displayInput,
    output: displayOutput,
    sourceText: null,
    outputLineCount: displayOutput ? displayOutput.split("\n").length : 0,
    createdAt: entry.createdAt,
  };
}

export function presentExecutionEntries(
  entries: readonly CodexRecordEntry[],
  active = false,
): ReadableExecution[] {
  const records = entries.map((entry) => presentExecutionEntry(entry));
  if (!active || records.some((record) => record.status === "running")) {
    return records;
  }

  const latestIndex = entries.length - 1;
  if (latestIndex >= 0 && entries[latestIndex]?.role === "reasoning") {
    records[latestIndex] = presentExecutionEntry(entries[latestIndex]!, { active: true });
  }
  return records;
}
