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
  remoteState: "current" | "stale" | "deleted-remotely";
  remoteSha256: string | null;
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
    remoteState: "current",
    remoteSha256: null,
  };
}

export function createReadyTab(document: IdeFileDocument): EditorTabState {
  return {
    ...createLoadingTab(document.path),
    status: "ready",
    value: document.content,
    savedValue: document.content,
    sha256: document.sha256,
    savedNotice: true,
    remoteSha256: document.sha256,
  };
}
