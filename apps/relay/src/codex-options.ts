import {
  codexModelSupportsFast,
  codexModelSupportsImages,
  codexModelSupportsReasoningEffort,
  normalizeCodexModelId,
  ProtocolError,
  type CodexAccessMode,
  type CodexCustomApprovalPolicy,
  type CodexCustomFileAccess,
  type CodexCustomPermissions,
  type CodexPromptOptions,
  type CodexReasoningEffort,
  type CodexSpeed,
} from "@codex-collab/protocol";

const allowedAccessModes = new Set<CodexAccessMode>([
  "follow-desktop",
  "request-approval",
  "auto",
  "full-access",
  "custom",
]);
const allowedReasoningEfforts = new Set<CodexReasoningEffort>([
  "follow-desktop",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
const allowedSpeeds = new Set<CodexSpeed>([
  "follow-desktop",
  "standard",
  "fast",
]);
const allowedCustomFileAccess = new Set<CodexCustomFileAccess>([
  "read-only",
  "workspace-write",
  "full-access",
]);
const allowedCustomApprovalPolicies = new Set<CodexCustomApprovalPolicy>([
  "on-request",
  "never",
]);

function parseCustomPermissions(value: unknown): CodexCustomPermissions {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(
      400,
      "invalid_request",
      "customPermissions are required for custom access",
    );
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.fileAccess !== "string" ||
    !allowedCustomFileAccess.has(record.fileAccess as CodexCustomFileAccess)
  ) {
    throw new ProtocolError(
      400,
      "invalid_request",
      "customPermissions.fileAccess is not supported",
    );
  }
  if (
    typeof record.approvalPolicy !== "string" ||
    !allowedCustomApprovalPolicies.has(
      record.approvalPolicy as CodexCustomApprovalPolicy,
    )
  ) {
    throw new ProtocolError(
      400,
      "invalid_request",
      "customPermissions.approvalPolicy is not supported",
    );
  }
  return {
    fileAccess: record.fileAccess as CodexCustomFileAccess,
    approvalPolicy: record.approvalPolicy as CodexCustomApprovalPolicy,
  };
}

export function validateCodexPromptCapabilities(
  options: CodexPromptOptions,
  attachments: ReadonlyArray<{ mediaType: string }> = [],
): void {
  if (!codexModelSupportsReasoningEffort(options.model, options.reasoningEffort)) {
    throw new ProtocolError(
      400,
      "invalid_request",
      `${options.reasoningEffort} reasoning is not supported by ${options.model}`,
    );
  }
  if (options.speed === "fast" && !codexModelSupportsFast(options.model)) {
    throw new ProtocolError(
      400,
      "invalid_request",
      `fast speed is not supported by ${options.model}`,
    );
  }
  if (
    !codexModelSupportsImages(options.model) &&
    attachments.some((attachment) => attachment.mediaType.startsWith("image/"))
  ) {
    throw new ProtocolError(
      400,
      "invalid_request",
      `${options.model} does not support image attachments`,
    );
  }
}

export function parseCodexOptions(value: unknown): CodexPromptOptions {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  let accessMode: CodexAccessMode = "follow-desktop";
  if (
    record.accessMode !== undefined &&
    record.accessMode !== null &&
    record.accessMode !== ""
  ) {
    if (
      typeof record.accessMode !== "string" ||
      !allowedAccessModes.has(record.accessMode as CodexAccessMode)
    ) {
      throw new ProtocolError(400, "invalid_request", "accessMode is not supported");
    }
    accessMode = record.accessMode as CodexAccessMode;
  }
  let reasoningEffort: CodexReasoningEffort = "follow-desktop";
  if (
    record.reasoningEffort !== undefined &&
    record.reasoningEffort !== null &&
    record.reasoningEffort !== ""
  ) {
    if (
      typeof record.reasoningEffort !== "string" ||
      !allowedReasoningEfforts.has(
        record.reasoningEffort as CodexReasoningEffort,
      )
    ) {
      throw new ProtocolError(
        400,
        "invalid_request",
        "reasoningEffort is not supported",
      );
    }
    reasoningEffort = record.reasoningEffort as CodexReasoningEffort;
  }
  let speed: CodexSpeed = "follow-desktop";
  if (record.speed !== undefined && record.speed !== null && record.speed !== "") {
    if (
      typeof record.speed !== "string" ||
      !allowedSpeeds.has(record.speed as CodexSpeed)
    ) {
      throw new ProtocolError(400, "invalid_request", "speed is not supported");
    }
    speed = record.speed as CodexSpeed;
  }

  let model: CodexPromptOptions["model"] = null;
  if (record.model !== null && record.model !== undefined && record.model !== "") {
    model =
      typeof record.model === "string"
        ? normalizeCodexModelId(record.model)
        : null;
    if (!model) {
      throw new ProtocolError(400, "invalid_request", "model is not supported");
    }
  }

  const options: CodexPromptOptions = {
    accessMode,
    customPermissions:
      accessMode === "custom" ? parseCustomPermissions(record.customPermissions) : null,
    model,
    reasoningEffort,
    speed,
    planMode: record.planMode === true,
  };
  validateCodexPromptCapabilities(options);
  return options;
}
