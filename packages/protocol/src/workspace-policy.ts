const PUBLISHABLE_WORKSPACE_EXTENSIONS = new Set([
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

const PRIVATE_WORKSPACE_FILE_NAMES = new Set([
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

function workspacePathName(path: string): string {
  return path.replaceAll("\\", "/").split("/").at(-1) ?? "";
}

export function isPublishableWorkspacePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const segments = normalized.split("/");
  const name = workspacePathName(normalized);
  if (
    segments.includes(".codex") ||
    segments.includes(".codex-collab") ||
    segments.includes(".git") ||
    segments.includes(".runtime-data") ||
    name === ".env" ||
    name.startsWith(".env.")
  ) {
    return false;
  }
  if (
    PRIVATE_WORKSPACE_FILE_NAMES.has(name) ||
    name.startsWith("service-account")
  ) {
    return false;
  }
  const dot = name.lastIndexOf(".");
  return dot >= 0 && PUBLISHABLE_WORKSPACE_EXTENSIONS.has(name.slice(dot));
}

export function codexConfigRelativePath(path: string): string | null {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (segments[0]?.toLowerCase() !== ".codex" || segments.length < 2) {
    return null;
  }
  return segments.slice(1).join("/");
}

export function isPublishableCodexConfigPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const segments = normalized.split("/");
  const name = workspacePathName(normalized);
  if (
    segments.some((segment) => CODEX_NON_CONFIG_DIRECTORIES.has(segment)) ||
    name === ".env" ||
    name.startsWith(".env.") ||
    PRIVATE_WORKSPACE_FILE_NAMES.has(name) ||
    name.startsWith("service-account")
  ) {
    return false;
  }
  const dot = name.lastIndexOf(".");
  return dot >= 0 && PUBLISHABLE_WORKSPACE_EXTENSIONS.has(name.slice(dot));
}

export function containsLikelySecret(content: string): boolean {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content)) return true;
  if (
    /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/.test(
      content,
    )
  ) {
    return true;
  }
  return /(?:^|\n)\s*(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|SECRET_KEY)\s*=\s*["']?(?!example|placeholder|change-me)[^\s"'#]{12,}/i.test(
    content,
  );
}

function normalizeCollabIgnorePath(path: string): string {
  return path
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/^\/+|\/+$/g, "");
}

export function isWorkspacePathIgnored(
  path: string,
  ignoredPaths: readonly string[],
  caseInsensitive = false,
): boolean {
  const normalizeCase = (value: string) =>
    caseInsensitive ? value.toLocaleLowerCase("en-US") : value;
  const normalizedPath = normalizeCase(normalizeCollabIgnorePath(path));
  return ignoredPaths.some((ignoredPath) => {
    const ignored = normalizeCase(normalizeCollabIgnorePath(ignoredPath));
    return Boolean(
      ignored &&
        (normalizedPath === ignored || normalizedPath.startsWith(`${ignored}/`)),
    );
  });
}

