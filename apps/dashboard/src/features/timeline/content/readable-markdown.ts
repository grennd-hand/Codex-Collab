import type { ReadableBlock, ReadableSourceKind } from "../execution/execution-presentation-types.js";

export function executionOutputNeedsViewport(text: string | null): boolean {
  if (!text) return false;

  const normalized = text.replace(/\r\n?/g, "\n");
  if (normalized.length > 2_000) return true;

  const lines = normalized.split("\n");
  return lines.length > 12 || lines.some((line) => line.length > 240);
}

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

