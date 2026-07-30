import type {
  CodexAccessMode,
  CodexCustomApprovalPolicy,
  CodexCustomFileAccess,
  CodexModelId,
  CodexPromptOptions,
  CodexReasoningEffort,
  CodexRuntimeStatus,
  CodexSpeed,
  Member,
  Message,
  WorkspaceSummary,
} from "@codex-collab/protocol";
import {
  DEFAULT_CODEX_CUSTOM_PERMISSIONS,
  DEFAULT_CODEX_PROMPT_OPTIONS,
  codexModelSupportsFast,
  codexModelSupportsImages,
  codexModelSupportsReasoningEffort,
  normalizeCodexModelId,
} from "@codex-collab/protocol";

export type ComposerMode = "codex" | "chat";
export type CodexExecutionPhase = "idle" | "queued" | "running" | "stopping";
export type ComposerPrimaryAction = "send_chat" | "send_codex" | "stop_codex";

export const reasoningEffortOrder: Exclude<
  CodexReasoningEffort,
  "follow-desktop"
>[] = ["low", "medium", "high", "xhigh", "max", "ultra"];

export const reasoningEffortLabels: Record<
  Exclude<CodexReasoningEffort, "follow-desktop">,
  string
> = {
  low: "轻度",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最大",
  ultra: "超强",
};

const accessModes = new Set<CodexAccessMode>([
  "follow-desktop",
  "request-approval",
  "auto",
  "full-access",
  "custom",
]);
const reasoningEfforts = new Set<CodexReasoningEffort>([
  "follow-desktop",
  ...reasoningEffortOrder,
]);
const speeds = new Set<CodexSpeed>(["follow-desktop", "standard", "fast"]);
const customFileAccessModes = new Set<CodexCustomFileAccess>([
  "read-only",
  "workspace-write",
  "full-access",
]);
const customApprovalPolicies = new Set<CodexCustomApprovalPolicy>([
  "on-request",
  "never",
]);

export function workspaceNeedsConversationLoad(
  workspace: Pick<WorkspaceSummary, "selectedThreadId" | "syncedAt"> | null,
): boolean {
  return Boolean(workspace?.selectedThreadId && !workspace.syncedAt);
}

export function codexExecutionPhase(
  messages: readonly Pick<Message, "kind" | "deliveryStatus">[],
  runtimeStatus: CodexRuntimeStatus | null | undefined,
  terminalHistoryObserved = false,
): CodexExecutionPhase {
  let latestPromptIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.kind === "codex_prompt") {
      latestPromptIndex = index;
      break;
    }
  }

  if (terminalHistoryObserved) {
    return "idle";
  }

  for (let index = messages.length - 1; index > latestPromptIndex; index -= 1) {
    const message = messages[index];
    if (message?.kind !== "codex_stop") continue;
    if (
      message.deliveryStatus === "queued" ||
      message.deliveryStatus === "submitted"
    ) {
      return "stopping";
    }
    if (message.deliveryStatus === "completed") {
      return "idle";
    }
    break;
  }

  const latestPrompt =
    latestPromptIndex >= 0 ? messages[latestPromptIndex] : undefined;
  if (
    runtimeStatus === "running" ||
    latestPrompt?.deliveryStatus === "submitted"
  ) {
    return "running";
  }
  if (latestPrompt?.deliveryStatus === "queued") {
    return "queued";
  }
  return "idle";
}

export function shouldShowExecutionStatus(
  phase: CodexExecutionPhase,
  hasRunningExecutionEntry: boolean,
): boolean {
  return phase !== "idle" && (phase !== "running" || !hasRunningExecutionEntry);
}

export function canMemberStopCodex(
  member: Pick<Member, "role" | "status"> | null,
  phase: CodexExecutionPhase,
): boolean {
  return (
    member?.status === "approved" &&
    phase !== "idle" &&
    phase !== "stopping"
  );
}

export function composerPrimaryAction(
  phase: CodexExecutionPhase,
  mode: ComposerMode,
): ComposerPrimaryAction {
  if (phase !== "idle") return "stop_codex";
  return mode === "chat" ? "send_chat" : "send_codex";
}

export function normalizeCodexOptionsForUi(value: unknown): CodexPromptOptions {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const accessMode =
    typeof record.accessMode === "string" &&
    accessModes.has(record.accessMode as CodexAccessMode)
      ? (record.accessMode as CodexAccessMode)
      : DEFAULT_CODEX_PROMPT_OPTIONS.accessMode;
  const model =
    typeof record.model === "string" ? normalizeCodexModelId(record.model) : null;
  let reasoningEffort =
    typeof record.reasoningEffort === "string" &&
    reasoningEfforts.has(record.reasoningEffort as CodexReasoningEffort)
      ? (record.reasoningEffort as CodexReasoningEffort)
      : DEFAULT_CODEX_PROMPT_OPTIONS.reasoningEffort;
  let speed =
    typeof record.speed === "string" && speeds.has(record.speed as CodexSpeed)
      ? (record.speed as CodexSpeed)
      : DEFAULT_CODEX_PROMPT_OPTIONS.speed;

  if (!codexModelSupportsReasoningEffort(model, reasoningEffort)) {
    const requestedIndex = reasoningEffortOrder.indexOf(
      reasoningEffort as Exclude<CodexReasoningEffort, "follow-desktop">,
    );
    reasoningEffort =
      reasoningEffortOrder
        .slice(0, Math.max(requestedIndex, 0) + 1)
        .reverse()
        .find((candidate) => codexModelSupportsReasoningEffort(model, candidate)) ??
      "medium";
  }
  if (speed === "fast" && !codexModelSupportsFast(model)) {
    speed = "standard";
  }

  const customRecord =
    record.customPermissions &&
    typeof record.customPermissions === "object" &&
    !Array.isArray(record.customPermissions)
      ? (record.customPermissions as Record<string, unknown>)
      : {};
  const fileAccess =
    typeof customRecord.fileAccess === "string" &&
    customFileAccessModes.has(customRecord.fileAccess as CodexCustomFileAccess)
      ? (customRecord.fileAccess as CodexCustomFileAccess)
      : DEFAULT_CODEX_CUSTOM_PERMISSIONS.fileAccess;
  const approvalPolicy =
    typeof customRecord.approvalPolicy === "string" &&
    customApprovalPolicies.has(
      customRecord.approvalPolicy as CodexCustomApprovalPolicy,
    )
      ? (customRecord.approvalPolicy as CodexCustomApprovalPolicy)
      : DEFAULT_CODEX_CUSTOM_PERMISSIONS.approvalPolicy;

  return {
    accessMode,
    customPermissions:
      accessMode === "custom" ? { fileAccess, approvalPolicy } : null,
    model,
    reasoningEffort,
    speed,
    planMode: record.planMode === true,
  };
}

export function filterUnsupportedImageAttachments<
  T extends { file: { type: string } },
>(model: CodexModelId | null, attachments: readonly T[]): T[] {
  return codexModelSupportsImages(model)
    ? [...attachments]
    : attachments.filter((attachment) => !attachment.file.type.startsWith("image/"));
}

export function chatMessageBody(draft: string, attachmentCount: number): string {
  const body = draft.trim();
  return body || (attachmentCount > 0 ? `发送了 ${attachmentCount} 个附件` : "");
}

type ComposerControl = Pick<
  HTMLInputElement | HTMLTextAreaElement,
  "disabled" | "focus" | "setSelectionRange" | "value"
>;

export function restoreComposerControlFocus(
  control: ComposerControl | null,
  schedule: (callback: FrameRequestCallback) => number = (callback) =>
    window.requestAnimationFrame(callback),
): void {
  schedule(() => {
    if (!control || control.disabled) return;
    control.focus();
    const cursorPosition = control.value.length;
    control.setSelectionRange(cursorPosition, cursorPosition);
  });
}
