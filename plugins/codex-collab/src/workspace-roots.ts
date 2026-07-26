import { basename, isAbsolute, parse, relative, sep } from "node:path";
import { FileSandbox } from "./file-sandbox.js";

function comparablePath(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

export function workspaceRootsEqual(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right);
}

function isSameOrNested(parent: string, candidate: string): boolean {
  const comparedParent = comparablePath(parent);
  const comparedCandidate = comparablePath(candidate);
  const child = relative(comparedParent, comparedCandidate);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

function assertProjectRoot(root: string): void {
  const pathWithoutVolume = root.slice(parse(root).root.length);
  if (
    pathWithoutVolume
      .split(/[\\/]+/)
      .some((segment) => segment.toLowerCase() === ".codex")
  ) {
    throw new Error("projectRoot cannot be a .codex directory or a directory inside .codex");
  }
}

export async function openProjectSandbox(root: string): Promise<FileSandbox> {
  const sandbox = await FileSandbox.create(root);
  assertProjectRoot(sandbox.getRoot());
  return sandbox;
}

export async function openWorkspaceSandboxes(
  projectRoot: string,
  codexConfigRoot?: string,
): Promise<{
  projectSandbox: FileSandbox;
  codexConfigSandbox: FileSandbox | null;
}> {
  const projectSandbox = await openProjectSandbox(projectRoot);
  if (!codexConfigRoot) return { projectSandbox, codexConfigSandbox: null };

  const codexConfigSandbox = await FileSandbox.create(codexConfigRoot);
  const resolvedConfigRoot = codexConfigSandbox.getRoot();
  if (basename(resolvedConfigRoot).toLowerCase() !== ".codex") {
    throw new Error("codexConfigRoot must explicitly point to a .codex directory");
  }
  const resolvedProjectRoot = projectSandbox.getRoot();
  if (
    isSameOrNested(resolvedProjectRoot, resolvedConfigRoot) ||
    isSameOrNested(resolvedConfigRoot, resolvedProjectRoot)
  ) {
    throw new Error("projectRoot and codexConfigRoot cannot overlap or contain one another");
  }
  return { projectSandbox, codexConfigSandbox };
}

export async function openBoundProjectSandbox(
  currentProjectRoot: string,
  requestedProjectRoot: string,
  codexConfigRoot?: string,
): Promise<FileSandbox> {
  const requested = await openProjectSandbox(requestedProjectRoot);
  const { projectSandbox } = await openWorkspaceSandboxes(
    currentProjectRoot,
    codexConfigRoot,
  );
  if (!workspaceRootsEqual(requested.getRoot(), projectSandbox.getRoot())) {
    throw new Error(
      "collab_bind_thread cannot change projectRoot; pair the host again for a different root",
    );
  }
  return projectSandbox;
}
