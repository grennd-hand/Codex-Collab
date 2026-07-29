import type { CodexFileChange } from "@codex-collab/protocol";

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
  role: "reasoning" | "commentary" | "command";
  title: string;
  status: ExecutionStatus;
  summary: string;
  input: string | null;
  output: string | null;
  sourceText: string | null;
  outputLineCount: number;
  createdAt: string | null;
  fileChanges: CodexFileChange[];
}

export interface PresentExecutionEntryOptions {
  active?: boolean;
}

export type ReadableSourceKind = "markdown" | "code";

