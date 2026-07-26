import {
  containsLikelySecret,
  isPublishableCodexConfigPath,
  isPublishableWorkspacePath,
  type WorkspaceFileContent,
} from "@codex-collab/protocol";
import { FileSandbox } from "./file-sandbox.js";

export {
  containsLikelySecret,
  isPublishableCodexConfigPath,
  isPublishableWorkspacePath,
} from "@codex-collab/protocol";

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
