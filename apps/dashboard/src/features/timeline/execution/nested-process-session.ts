import type { CodexRecordEntry } from "@codex-collab/protocol";

export interface NestedProcessSession {
  kind: "start" | "continuation";
  sessionId: string;
  running: boolean;
  exitCode: number | null;
}

function taggedSections(text: string): { input: string; output: string } | null {
  const inputMarker = text.indexOf("\ninput:\n");
  const outputMarker = text.indexOf("\noutput:\n");
  if (inputMarker < 0 || outputMarker < inputMarker) return null;
  return {
    input: text.slice(inputMarker + "\ninput:\n".length, outputMarker),
    output: text.slice(outputMarker + "\noutput:\n".length),
  };
}

function returnedSessionId(output: string): string | null {
  return (
    [...output.matchAll(/^session=(\d+)\s*$/gm)].at(-1)?.[1] ??
    [...output.matchAll(/"session_id"\s*:\s*(\d+)/g)].at(-1)?.[1] ??
    null
  );
}

function returnedExitCode(output: string): number | null {
  const value =
    [...output.matchAll(/^exit=(-?\d+)\s*$/gm)].at(-1)?.[1] ??
    [...output.matchAll(/"exit_code"\s*:\s*(-?\d+)/g)].at(-1)?.[1];
  return value === undefined ? null : Number(value);
}

export function nestedProcessSession(
  entry: CodexRecordEntry,
): NestedProcessSession | null {
  if (entry.role !== "command") return null;
  const sections = taggedSections(entry.text.replace(/\r\n?/g, "\n"));
  if (!sections) return null;

  const continuation = sections.input.match(
    /\btools\.write_stdin\s*\(\s*\{[\s\S]{0,500}?\bsession_id\s*:\s*(\d+)/,
  );
  if (continuation?.[1]) {
    const sessionId = continuation[1];
    return {
      kind: "continuation",
      sessionId,
      running: returnedSessionId(sections.output) === sessionId,
      exitCode: returnedExitCode(sections.output),
    };
  }

  if (!/\btools\.exec_command\s*\(/.test(sections.input)) return null;
  const sessionId = returnedSessionId(sections.output);
  return sessionId
    ? { kind: "start", sessionId, running: true, exitCode: null }
    : null;
}
