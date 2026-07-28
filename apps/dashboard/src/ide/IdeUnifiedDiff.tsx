import type { CodexFileChange } from "@codex-collab/protocol";

interface UnifiedDiff {
  text: string;
  truncated: boolean;
}

export function normalizedUnifiedDiff(
  diff: CodexFileChange["diff"],
): UnifiedDiff | null {
  if (typeof diff === "string") {
    return diff.length > 0 ? { text: diff, truncated: false } : null;
  }
  return diff?.text ? { text: diff.text, truncated: diff.truncated } : null;
}

function diffLineKind(line: string): "addition" | "deletion" | "hunk" | "context" {
  if (line.startsWith("+") && !line.startsWith("+++")) return "addition";
  if (line.startsWith("-") && !line.startsWith("---")) return "deletion";
  if (line.startsWith("@@")) return "hunk";
  return "context";
}

export function IdeUnifiedDiff({ diff }: { diff: CodexFileChange["diff"] }) {
  const normalized = normalizedUnifiedDiff(diff);
  if (!normalized) return null;
  const lines = normalized.text.split("\n");
  return (
    <div className="ide-unified-diff" role="region" aria-label="统一格式变更预览">
      <pre tabIndex={0}>
        <code>
          {lines.map((line, index) => (
            <span data-diff-line={diffLineKind(line)} key={`${index}:${line}`}>
              {line}
              {index < lines.length - 1 ? "\n" : null}
            </span>
          ))}
        </code>
      </pre>
      {normalized.truncated ? (
        <small>预览已截断，请打开文件查看完整内容。</small>
      ) : null}
    </div>
  );
}
