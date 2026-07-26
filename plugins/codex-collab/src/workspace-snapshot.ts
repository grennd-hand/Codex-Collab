import { basename, extname } from "node:path";
import {
  containsLikelySecret,
  isPublishableWorkspacePath,
  type WorkspaceFileContent,
} from "@codex-collab/protocol";
import { FileSandbox } from "./file-sandbox.js";

export { containsLikelySecret, isPublishableWorkspacePath } from "@codex-collab/protocol";

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

const COLLAB_IGNORE_FILE = ".codex-collabignore";

export function parseCollabIgnore(content: string): string[] {
  return content
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("!"));
}

export async function readCollabIgnore(sandbox: FileSandbox): Promise<string[]> {
  try {
    return parseCollabIgnore((await sandbox.read(COLLAB_IGNORE_FILE)).content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
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

async function buildTextSnapshot(
  sandbox: FileSandbox,
  options: {
    isAllowed(path: string): boolean;
    maxFiles: number;
    maxTotalBytes: number;
    pathPrefix?: string;
    ignoredPaths?: readonly string[];
  },
): Promise<WorkspaceFileContent[]> {
  const candidates = (await sandbox.list(2_000, options.ignoredPaths))
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
    ignoredPaths: await readCollabIgnore(sandbox),
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
