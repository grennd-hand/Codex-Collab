export type IdeCreateEntryKind = "file" | "directory";

export interface IdeTreeSelection {
  kind: "file" | "directory";
  path: string;
}

export interface PendingIdeCreate {
  id: number;
  kind: IdeCreateEntryKind;
  parentPath: string;
}

export function defaultCreateEntryName(kind: IdeCreateEntryKind): string {
  return kind === "file" ? "untitled.txt" : "";
}

function parentPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const separator = normalized.lastIndexOf("/");
  return separator < 0 ? "" : normalized.slice(0, separator);
}

export function createEntryParentPath(
  selection: IdeTreeSelection | null,
  activeFilePath: string | null,
): string {
  if (selection) {
    return selection.kind === "directory"
      ? selection.path
      : parentPath(selection.path);
  }
  return activeFilePath ? parentPath(activeFilePath) : "";
}

export function createWorkspaceEntryPath(
  parent: string,
  requestedName: string,
): string {
  const name = requestedName.trim();
  if (!name) throw new Error("请输入名称。");
  if (
    name === "." ||
    name === ".." ||
    name.endsWith(".") ||
    name.endsWith(" ") ||
    name.includes("/") ||
    name.includes("\\") ||
    /[\u0000-\u001f<>:"|?*]/.test(name) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  ) {
    throw new Error("请输入不含路径分隔符或系统保留字符的名称。");
  }
  return parent ? `${parent}/${name}` : name;
}

export function renameWorkspaceEntryPath(
  currentPath: string,
  requestedName: string,
): string {
  return createWorkspaceEntryPath(parentPath(currentPath), requestedName);
}
