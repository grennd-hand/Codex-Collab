import { extname } from "node:path";
import {
  codexModelSupportsFast,
  codexModelSupportsImages,
  codexModelSupportsReasoningEffort,
  normalizeCodexModelId,
  type CodexPromptOptions,
  type CodexReasoningEffort,
} from "@codex-collab/protocol";

export type CodexUserInput =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "localImage"; path: string; detail: "auto" }
  | { type: "mention"; name: string; path: string };

const MODEL_IDS: Readonly<Record<string, string>> = {
  "5.6 Sol": "gpt-5.6-sol",
  "5.6 Terra": "gpt-5.6-terra",
  "5.6 Luna": "gpt-5.6-luna",
  "5.5": "gpt-5.5",
  "5.4": "gpt-5.4",
  "5.4 Mini": "gpt-5.4-mini",
  "5.3 Codex Spark": "gpt-5.3-codex-spark",
};

const INLINE_TEXT_EXTENSIONS = new Set([
  ".cfg",
  ".conf",
  ".css",
  ".csv",
  ".html",
  ".ini",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".log",
  ".md",
  ".mjs",
  ".mts",
  ".ps1",
  ".py",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

export function decodeInlineTextAttachment(input: {
  name: string;
  mediaType: string;
  content: Uint8Array;
}): string | null {
  if (input.content.byteLength > 1_000_000) return null;
  const mediaType = input.mediaType.toLowerCase();
  const isText =
    mediaType.startsWith("text/") ||
    mediaType === "application/json" ||
    mediaType === "application/javascript" ||
    mediaType === "application/xml" ||
    INLINE_TEXT_EXTENSIONS.has(extname(input.name).toLowerCase());
  if (!isText) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(input.content);
  } catch {
    return null;
  }
}

export function resolveModelId(model: string | null): string | null {
  if (!model) return null;
  return MODEL_IDS[model] ?? model;
}

export function isUnmaterializedThreadError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("is not materialized yet") ||
      error.message.includes("no rollout found for thread id"))
  );
}

export function isEmptyRolloutError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("rollout") &&
    error.message.includes("is empty");
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function nestedTurnId(value: unknown, depth = 0): string | null {
  if (
    depth > 6 ||
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.turnId === "string" && record.turnId.length > 0) {
    return record.turnId;
  }
  const turn = record.turn;
  if (
    typeof turn === "object" &&
    turn !== null &&
    !Array.isArray(turn) &&
    typeof (turn as Record<string, unknown>).id === "string"
  ) {
    return (turn as Record<string, unknown>).id as string;
  }
  for (const key of ["result", "response", "data"]) {
    const found = nestedTurnId(record[key], depth + 1);
    if (found) return found;
  }
  return null;
}

export function buildCodexTurnStartParams(input: {
  threadId: string;
  userInput: CodexUserInput[];
  attachmentMediaTypes?: readonly string[];
  options: CodexPromptOptions;
  currentModel?: string | null;
  currentReasoningEffort?: string | null;
  peerDisplayName: string;
  commandId?: string;
  ownerAuthored?: boolean;
}): Record<string, unknown> {
  const requestedModel = resolveModelId(input.options.model);
  const effectiveModel = requestedModel ?? input.currentModel ?? null;
  const knownEffectiveModel = effectiveModel
    ? normalizeCodexModelId(effectiveModel)
    : null;
  const requestedEffort =
    input.options.reasoningEffort === "follow-desktop"
      ? null
      : input.options.reasoningEffort;
  if (
    knownEffectiveModel &&
    !codexModelSupportsReasoningEffort(
      knownEffectiveModel,
      input.options.reasoningEffort,
    )
  ) {
    throw new Error(
      `${input.options.reasoningEffort} reasoning is not supported by ${knownEffectiveModel}`,
    );
  }
  if (
    knownEffectiveModel &&
    input.options.speed === "fast" &&
    !codexModelSupportsFast(knownEffectiveModel)
  ) {
    throw new Error(`Fast speed is not supported by ${knownEffectiveModel}`);
  }
  if (
    knownEffectiveModel &&
    !codexModelSupportsImages(knownEffectiveModel) &&
    (input.userInput.some((item) => item.type === "localImage") ||
      input.attachmentMediaTypes?.some((mediaType) =>
        mediaType.startsWith("image/"),
      ))
  ) {
    throw new Error(`Image attachments are not supported by ${knownEffectiveModel}`);
  }
  const parameters: Record<string, unknown> = {
    threadId: input.threadId,
    input: input.userInput,
    responsesapiClientMetadata: {
      source: "codex-collab",
      collab_member: input.peerDisplayName,
      ...(input.commandId ? { collab_command_id: input.commandId } : {}),
    },
  };

  if (requestedModel) parameters.model = requestedModel;
  if (requestedEffort) parameters.effort = requestedEffort;
  if (input.options.speed === "fast") {
    parameters.serviceTier = "priority";
  } else if (input.options.speed === "standard") {
    parameters.serviceTier = null;
  }

  if (input.options.accessMode === "request-approval") {
    parameters.permissions = ":workspace";
    parameters.approvalPolicy = "on-request";
  } else if (input.options.accessMode === "auto") {
    parameters.permissions = ":workspace";
    parameters.approvalPolicy = "never";
  } else if (input.options.accessMode === "full-access") {
    parameters.permissions = ":danger-full-access";
    parameters.approvalPolicy = "never";
  } else if (input.options.accessMode === "custom") {
    const customPermissions = input.options.customPermissions;
    if (!customPermissions) {
      throw new Error("Custom Codex permissions are missing");
    }
    const permissionProfile = {
      "read-only": ":read-only",
      "workspace-write": ":workspace",
      "full-access": ":danger-full-access",
    }[customPermissions.fileAccess];
    if (!permissionProfile) {
      throw new Error("Custom Codex file access is invalid");
    }
    if (
      customPermissions.approvalPolicy !== "on-request" &&
      customPermissions.approvalPolicy !== "never"
    ) {
      throw new Error("Custom Codex approval policy is invalid");
    }
    parameters.permissions = permissionProfile;
    parameters.approvalPolicy = customPermissions.approvalPolicy;
  }

  if (input.ownerAuthored !== true) {
    parameters.permissions = ":workspace";
    parameters.approvalPolicy = "on-request";
  }

  if (input.options.planMode || requestedModel || requestedEffort) {
    if (!effectiveModel) {
      throw new Error(
        "Selected Codex options require the selected task's current model",
      );
    }
    parameters.collaborationMode = {
      mode: input.options.planMode ? "plan" : "default",
      settings: {
        model: effectiveModel,
        reasoning_effort:
          requestedEffort ??
          (knownEffectiveModel && input.currentReasoningEffort
            ? codexModelSupportsReasoningEffort(
                knownEffectiveModel,
                input.currentReasoningEffort as CodexReasoningEffort,
              )
              ? input.currentReasoningEffort
              : null
            : input.currentReasoningEffort ?? null),
        developer_instructions: null,
      },
    };
  }
  return parameters;
}
