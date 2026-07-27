import { lstat, mkdir, readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  isPublishableWorkspaceDirectoryPath,
  isWorkspacePathIgnored,
} from "@codex-collab/protocol";

export const SKIPPED_WORKSPACE_DIRECTORIES = new Set([
  ".codex-collab",
  ".git",
  ".next",
  ".runtime-data",
  "coverage",
  "dist",
  "node_modules",
]);

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function normalizedDirectoryPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/^\/+|\/+$/g, "");
}

export async function createSafeWorkspaceDirectory(
  root: string,
  requestedPath: string,
): Promise<string> {
  const path = normalizedDirectoryPath(requestedPath);
  if (
    !path ||
    isAbsolute(requestedPath) ||
    /^[A-Za-z]:/.test(requestedPath) ||
    !isPublishableWorkspaceDirectoryPath(path)
  ) {
    throw new Error("Directory path is outside the approved shared root");
  }

  let current = root;
  const segments = path.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    current = resolve(current, segment);
    if (!isInside(root, current)) {
      throw new Error("Directory path is outside the approved shared root");
    }
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        throw new Error("Creating directories through symbolic links is not supported");
      }
      if (!metadata.isDirectory()) throw new Error("A directory path is occupied by a file");
      if (index === segments.length - 1) throw new Error("Directory already exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
  return path;
}

export async function listSafeWorkspaceDirectories(
  root: string,
  ignoredPaths: readonly string[],
  maxDirectories = 2_000,
): Promise<string[]> {
  const directories: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (directories.length >= maxDirectories) return;
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const absolute = resolve(directory, entry.name);
      const path = relative(root, absolute).split(sep).join("/");
      if (
        SKIPPED_WORKSPACE_DIRECTORIES.has(entry.name) ||
        !isPublishableWorkspaceDirectoryPath(path) ||
        isWorkspacePathIgnored(path, ignoredPaths, process.platform === "win32")
      ) {
        continue;
      }
      directories.push(path);
      await visit(absolute);
    }
  };
  await visit(root);
  return directories;
}
