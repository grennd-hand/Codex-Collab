import type { IdeFileDocument } from "./types.js";

export interface ConflictState {
  remote: IdeFileDocument;
  message: string;
}

export interface EditorTabState {
  path: string;
  status: "loading" | "ready" | "error";
  value: string;
  savedValue: string;
  sha256: string;
  error: string | null;
  saveError: string | null;
  saving: boolean;
  savedNotice: boolean;
  conflict: ConflictState | null;
}

export function fileName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

export function messageFromError(caught: unknown): string {
  return caught instanceof Error ? caught.message : "文件操作未完成。";
}

export function createLoadingTab(path: string): EditorTabState {
  return {
    path,
    status: "loading",
    value: "",
    savedValue: "",
    sha256: "",
    error: null,
    saveError: null,
    saving: false,
    savedNotice: false,
    conflict: null,
  };
}
