import { basename, extname } from "node:path";
import type { WorkspaceFileContent } from "@codex-collab/protocol";
import { FileSandbox } from "./file-sandbox.js";

const PUBLISHABLE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".cfg",
  ".conf",
  ".go",
  ".h",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".md",
  ".mjs",
  ".mts",
  ".ps1",
  ".py",
  ".rs",
  ".rules",
  ".scss",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

const SENSITIVE_NAMES = new Set([
  ".netrc",
  ".npmrc",
  ".pypirc",
  "auth.json",
  "auth.toml",
  "cookies.json",
  "credentials.json",
  "id_ed25519",
  "id_rsa",
  "history.jsonl",
  "secrets.json",
  "state.json",
  "tokens.json",
]);

const CODEX_NON_CONFIG_DIRECTORIES = new Set([
  "archived_sessions",
  "attachments",
  "cache",
  "history",
  "logs",
  "memories",
  "projects",
  "rollouts",
  "sessions",
  "shell_snapshots",
  "threads",
  "tmp",
]);

export function isPublishableWorkspacePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const segments = normalized.split("/");
  const name = basename(normalized);
  if (
    segments.includes(".codex") ||
    segments.includes(".codex-collab") ||
    name === ".env" ||
    name.startsWith(".env.")
  ) {
    return false;
  }
  if (SENSITIVE_NAMES.has(name) || name.startsWith("service-account")) {
    return false;
  }
  return PUBLISHABLE_EXTENSIONS.has(extname(name));
}

export function isPublishableCodexConfigPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const segments = normalized.split("/");
  const name = basename(normalized);
  if (
    segments.some((segment) => CODEX_NON_CONFIG_DIRECTORIES.has(segment)) ||
    name === ".env" ||
    name.startsWith(".env.") ||
    SENSITIVE_NAMES.has(name) ||
    name.startsWith("service-account")
  ) {
    return false;
  }
  return PUBLISHABLE_EXTENSIONS.has(extname(name));
}

export function containsLikelySecret(content: string): boolean {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content)) return true;
  if (/\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/.test(content)) {
    return true;
  }
  return /(?:^|\n)\s*(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|SECRET_KEY)\s*=\s*["']?(?!example|placeholder|change-me)[^\s"'#]{12,}/i.test(
    content,
  );
}

async function buildTextSnapshot(
  sandbox: FileSandbox,
  options: {
    isAllowed(path: string): boolean;
    maxFiles: number;
    maxTotalBytes: number;
    pathPrefix?: string;
  },
): Promise<WorkspaceFileContent[]> {
  const candidates = (await sandbox.list(2_000))
    .filter((file) => file.size <= 256_000 && options.isAllowed(file.path))
    .slice(0, options.maxFiles);
  const files: WorkspaceFileContent[] = [];
  let totalBytes = 0;
  for (const candidate of candidates) {
    const file = await sandbox.read(candidate.path);
    const contentBytes = Buffer.byteLength(file.content);
    if (
      contentBytes > 256_000 ||
      totalBytes + contentBytes > options.maxTotalBytes ||
      file.content.includes("\0") ||
      containsLikelySecret(file.content)
    ) {
      continue;
    }
    totalBytes += contentBytes;
    files.push({
      path: `${options.pathPrefix ?? ""}${file.path}`,
      content: file.content,
      size: contentBytes,
      modifiedAt: file.modifiedAt,
      sha256: file.sha256,
    });
  }
  return files;
}

export async function buildWorkspaceSnapshot(
  sandbox: FileSandbox,
): Promise<WorkspaceFileContent[]> {
  return buildTextSnapshot(sandbox, {
    isAllowed: isPublishableWorkspacePath,
    maxFiles: 400,
    maxTotalBytes: 4_000_000,
  });
}

export async function buildCodexConfigSnapshot(
  sandbox: FileSandbox,
): Promise<WorkspaceFileContent[]> {
  return buildTextSnapshot(sandbox, {
    isAllowed: isPublishableCodexConfigPath,
    maxFiles: 200,
    maxTotalBytes: 1_000_000,
    pathPrefix: ".codex/",
  });
}
