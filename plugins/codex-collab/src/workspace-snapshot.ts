import { basename, extname } from "node:path";
import type { WorkspaceFileContent } from "@codex-collab/protocol";
import { FileSandbox } from "./file-sandbox.js";

const PUBLISHABLE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".h",
  ".html",
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
  "credentials.json",
  "id_ed25519",
  "id_rsa",
]);

export function isPublishableWorkspacePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const segments = normalized.split("/");
  const name = basename(normalized);
  if (segments.includes(".codex") || name === ".env" || name.startsWith(".env.")) {
    return false;
  }
  if (SENSITIVE_NAMES.has(name) || name.startsWith("service-account")) {
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

export async function buildWorkspaceSnapshot(
  sandbox: FileSandbox,
): Promise<WorkspaceFileContent[]> {
  const candidates = (await sandbox.list(2_000))
    .filter((file) => file.size <= 256_000 && isPublishableWorkspacePath(file.path))
    .slice(0, 500);
  const files: WorkspaceFileContent[] = [];
  let totalBytes = 0;
  for (const candidate of candidates) {
    const file = await sandbox.read(candidate.path);
    const contentBytes = Buffer.byteLength(file.content);
    if (
      contentBytes > 256_000 ||
      totalBytes + contentBytes > 5_000_000 ||
      file.content.includes("\0") ||
      containsLikelySecret(file.content)
    ) {
      continue;
    }
    totalBytes += contentBytes;
    files.push({
      path: file.path,
      content: file.content,
      size: contentBytes,
      modifiedAt: file.modifiedAt,
      sha256: file.sha256,
    });
  }
  return files;
}
