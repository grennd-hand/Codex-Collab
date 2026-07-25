import {
  normalizeCodexModelId,
  ProtocolError,
  type CodexAccessMode,
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
]);
const allowedSpeeds = new Set<CodexSpeed>([
  "follow-desktop",
  "standard",
  "fast",
]);

export function parseCodexOptions(value: unknown): CodexPromptOptions {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const accessMode =
    typeof record.accessMode === "string" &&
    allowedAccessModes.has(record.accessMode as CodexAccessMode)
      ? (record.accessMode as CodexAccessMode)
      : "follow-desktop";
  const reasoningEffort =
    typeof record.reasoningEffort === "string" &&
    allowedReasoningEfforts.has(record.reasoningEffort as CodexReasoningEffort)
      ? (record.reasoningEffort as CodexReasoningEffort)
      : "follow-desktop";
  const speed =
    typeof record.speed === "string" && allowedSpeeds.has(record.speed as CodexSpeed)
      ? (record.speed as CodexSpeed)
      : "follow-desktop";

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

  return {
    accessMode,
    model,
    reasoningEffort,
    speed,
    planMode: record.planMode === true,
  };
}
