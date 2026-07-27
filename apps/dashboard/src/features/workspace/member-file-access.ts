import type { Member } from "@codex-collab/protocol";

export type WorkspaceFileAccess = "read-only" | "workspace-write";

export type MemberWithWorkspaceFileAccess = Member & {
  workspaceFileAccess?: WorkspaceFileAccess;
};

export function memberWorkspaceFileAccess(
  member: Member | null | undefined,
): WorkspaceFileAccess {
  if (member?.role === "owner") return "workspace-write";
  return (member as MemberWithWorkspaceFileAccess | null | undefined)
    ?.workspaceFileAccess === "workspace-write"
    ? "workspace-write"
    : "read-only";
}
