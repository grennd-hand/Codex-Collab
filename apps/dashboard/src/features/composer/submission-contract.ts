import type { MessageKind } from "@codex-collab/protocol";
import { ApiRequestError } from "../../shared/api/api-client.js";

export const STALE_WORKSPACE_THREAD_MESSAGE =
  "所选 Codex 任务已发生变化，请确认当前任务后重新发送";

export function expectedWorkspaceThreadForSubmission(
  kind: MessageKind,
  selectedThreadId: string | null,
): string | null {
  return kind === "codex_prompt" ? selectedThreadId?.trim() || null : null;
}

export function isStaleWorkspaceThreadError(
  caught: unknown,
): caught is ApiRequestError {
  return (
    caught instanceof ApiRequestError &&
    caught.status === 409 &&
    caught.code === "stale_workspace_thread"
  );
}
