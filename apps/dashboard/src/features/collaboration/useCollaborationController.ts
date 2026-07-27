import type { Member, Session } from "@codex-collab/protocol";
import { useState } from "react";
import { requestJson } from "../../shared/api/api-client.js";
import {
  type MemberWithWorkspaceFileAccess,
  type WorkspaceFileAccess,
} from "../workspace/member-file-access.js";

type CollaborationControllerOptions = {
  authHeaders: (includeJson?: boolean) => HeadersInit;
  currentMember: Member | null;
  onError: (caught: unknown) => void;
  pushActivity: (
    title: string,
    detail: string,
    tone?: "info" | "success" | "warning" | "danger",
  ) => void;
  refresh: () => Promise<void>;
  session: Session | null;
  setError: (message: string | null) => void;
  setMembers: (update: (members: Member[]) => Member[]) => void;
};

export function useCollaborationController({
  authHeaders,
  currentMember,
  onError,
  pushActivity,
  refresh,
  session,
  setError,
  setMembers,
}: CollaborationControllerOptions) {
  const [workspaceAccessUpdatingMemberId, setWorkspaceAccessUpdatingMemberId] =
    useState<string | null>(null);

  const approveMember = async (target: Member) => {
    if (!session) return;
    try {
      await requestJson<{ member: Member }>(
        `/v1/sessions/${session.id}/members/${target.id}/approve`,
        {
          method: "POST",
          headers: authHeaders(true),
          body: "{}",
        },
      );
      pushActivity("成员已批准", target.displayName, "success");
      await refresh();
    } catch (caught) {
      onError(caught);
    }
  };

  const updateWorkspaceFileAccess = async (
    target: Member,
    workspaceFileAccess: WorkspaceFileAccess,
  ) => {
    if (!session || currentMember?.role !== "owner" || target.role === "owner") {
      return;
    }
    setWorkspaceAccessUpdatingMemberId(target.id);
    try {
      const result = await requestJson<{ member: MemberWithWorkspaceFileAccess }>(
        `/v1/sessions/${encodeURIComponent(session.id)}/members/${encodeURIComponent(target.id)}/workspace-file-access`,
        {
          method: "PATCH",
          headers: authHeaders(true),
          body: JSON.stringify({ workspaceFileAccess }),
        },
      );
      setMembers((members) =>
        members.map((item) => (item.id === target.id ? result.member : item)),
      );
      pushActivity(
        "项目文件权限已更新",
        `${target.displayName}：${
          workspaceFileAccess === "workspace-write" ? "项目文件可写" : "项目文件只读"
        }`,
        "success",
      );
      setError(null);
    } catch (caught) {
      onError(caught);
    } finally {
      setWorkspaceAccessUpdatingMemberId(null);
    }
  };

  return {
    approveMember,
    updateWorkspaceFileAccess,
    workspaceAccessUpdatingMemberId,
  };
}
