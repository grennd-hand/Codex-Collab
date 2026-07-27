import { isAbsolute, dirname, relative, resolve, sep } from "node:path";
import type { ReadSharedFile } from "./file-sandbox.js";
import { runWindowsEntryRename } from "./windows-entry-rename.js";

interface RenameSandboxEntryOptions {
  root: string;
  source: string;
  destinationPath: string;
  expectedSha256: string | null;
  sourceFile: ReadSharedFile | null;
  platform: NodeJS.Platform;
}

export class SandboxRenameConflictError extends Error {}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

export async function renameSandboxEntry({
  root,
  source,
  destinationPath,
  expectedSha256,
  sourceFile,
  platform,
}: RenameSandboxEntryOptions): Promise<ReadSharedFile | null> {
  if (platform !== "win32") {
    throw new Error("Collaboration rename requires Windows guarded file support");
  }
  const destination = resolve(root, destinationPath);
  if (!isInside(root, destination) || dirname(source) !== dirname(destination)) {
    throw new Error("Rename must stay inside the same approved parent directory");
  }
  if (sourceFile && sourceFile.sha256 !== expectedSha256) {
    throw new SandboxRenameConflictError("File changed before the guarded rename");
  }
  const result = await runWindowsEntryRename({
    root,
    source,
    destinationParent: dirname(destination),
    destination,
    expectedSha256,
    isDirectory: sourceFile === null,
  });
  if (result.status === "conflict") throw new SandboxRenameConflictError(result.message);
  if (result.status !== "committed") throw new Error(result.message);
  return sourceFile
    ? { ...sourceFile, path: destinationPath.replaceAll("\\", "/") }
    : null;
}
