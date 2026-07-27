import type { IdeWorkspaceFile } from "./types.js";

export interface IdeFileTreeNode {
  id: string;
  name: string;
  path: string;
  kind: "directory" | "file";
  file?: IdeWorkspaceFile;
  children: IdeFileTreeNode[];
}

interface MutableTreeNode {
  id: string;
  name: string;
  path: string;
  kind: "directory" | "file";
  file?: IdeWorkspaceFile;
  childMap: Map<string, MutableTreeNode>;
}

export function normalizeWorkspacePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/{2,}/g, "/");
}

export function resolveWorkspaceFilePath(
  requestedPath: string,
  files: readonly Pick<IdeWorkspaceFile, "path">[],
): string | null {
  const requested = normalizeWorkspacePath(requestedPath).replace(/^\/+/, "");
  const exact = files.find(
    (file) => normalizeWorkspacePath(file.path) === requested,
  );
  if (exact) return normalizeWorkspacePath(exact.path);

  const requestedLower = requested.toLocaleLowerCase();
  const suffixMatches = files.filter((file) => {
    const candidate = normalizeWorkspacePath(file.path);
    const candidateLower = candidate.toLocaleLowerCase();
    return (
      candidateLower === requestedLower ||
      requestedLower.endsWith(`/${candidateLower}`)
    );
  });
  return suffixMatches.length === 1
    ? normalizeWorkspacePath(suffixMatches[0]!.path)
    : null;
}

function compareNodes(left: IdeFileTreeNode, right: IdeFileTreeNode): number {
  if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
  return left.name.localeCompare(right.name, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

export function buildFileTree(files: readonly IdeWorkspaceFile[]): IdeFileTreeNode[] {
  const roots = new Map<string, MutableTreeNode>();

  for (const file of files) {
    const normalized = normalizeWorkspacePath(file.path);
    const segments = normalized.split("/").filter(Boolean);
    if (segments.length === 0) continue;

    let current = roots;
    let parentPath = "";
    segments.forEach((segment, index) => {
      const path = parentPath ? `${parentPath}/${segment}` : segment;
      const isFile = index === segments.length - 1;
      let node = current.get(segment);
      if (!node) {
        node = {
          id: `${isFile ? "file" : "directory"}:${path}`,
          name: segment,
          path,
          kind: isFile ? "file" : "directory",
          file: isFile ? { ...file, path: normalized } : undefined,
          childMap: new Map(),
        };
        current.set(segment, node);
      }

      parentPath = path;
      if (!isFile) {
        current = node.childMap;
      }
    });
  }

  const materialize = (nodes: Map<string, MutableTreeNode>): IdeFileTreeNode[] =>
    [...nodes.values()]
      .map((node) => {
        return {
          id: node.id,
          name: node.name,
          path: node.path,
          kind: node.kind,
          file: node.file,
          children: materialize(node.childMap),
        } satisfies IdeFileTreeNode;
      })
      .sort(compareNodes);

  return materialize(roots);
}

export function filterFileTree(
  nodes: readonly IdeFileTreeNode[],
  query: string,
): IdeFileTreeNode[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return [...nodes];

  const filtered: IdeFileTreeNode[] = [];
  for (const node of nodes) {
    if (node.kind === "file") {
      if (node.path.toLocaleLowerCase().includes(normalizedQuery)) filtered.push(node);
      continue;
    }
    const children = filterFileTree(node.children, normalizedQuery);
    if (children.length > 0) filtered.push({ ...node, children });
  }
  return filtered;
}

export function collectDirectoryPaths(
  nodes: readonly IdeFileTreeNode[],
): Set<string> {
  const paths = new Set<string>();
  const visit = (items: readonly IdeFileTreeNode[]) => {
    for (const item of items) {
      if (item.kind !== "directory") continue;
      paths.add(item.path);
      visit(item.children);
    }
  };
  visit(nodes);
  return paths;
}

const languageByExtension: Readonly<Record<string, string>> = {
  c: "c",
  cc: "cpp",
  cjs: "javascript",
  cmd: "bat",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  go: "go",
  gql: "graphql",
  graphql: "graphql",
  h: "cpp",
  html: "html",
  java: "java",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "javascript",
  kt: "kotlin",
  md: "markdown",
  mdx: "mdx",
  mjs: "javascript",
  mts: "typescript",
  cts: "typescript",
  less: "less",
  php: "php",
  py: "python",
  ps1: "powershell",
  rb: "ruby",
  rs: "rust",
  scss: "scss",
  sh: "shell",
  bat: "bat",
  sql: "sql",
  svg: "xml",
  toml: "ini",
  ts: "typescript",
  tsx: "typescript",
  txt: "plaintext",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
};

export function languageForPath(path: string): string {
  const name = path.split("/").at(-1)?.toLocaleLowerCase() ?? "";
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return "dockerfile";
  if (name === "makefile") return "makefile";
  if (name === ".env" || name.startsWith(".env.")) return "ini";
  const extension = name.includes(".") ? name.split(".").at(-1) ?? "" : "";
  return languageByExtension[extension] ?? "plaintext";
}
