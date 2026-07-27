const CODEX_FILES_HEADER = "# Files mentioned by the user:";
const CODEX_REQUEST_HEADER = "## My request for Codex:";
const CODEX_INTERNAL_DIRECTIVE =
  /^::(?:created-thread|code-comment|git-(?:stage|commit|push|create-branch|create-pr))\{.*\}$/;

function isAbsoluteCodexAttachmentPath(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value);
}

export function sanitizeCodexUserMessageText(text: string): string {
  const lines = text.split(/\r?\n/);
  const firstContentIndex = lines.findIndex((line) => line.trim());
  if (
    firstContentIndex < 0 ||
    lines[firstContentIndex]?.trim() !== CODEX_FILES_HEADER
  ) {
    return text;
  }

  const requestHeaderIndex = lines.findIndex(
    (line, index) =>
      index > firstContentIndex && line.trim() === CODEX_REQUEST_HEADER,
  );
  if (requestHeaderIndex < 0) return text;

  let attachmentCount = 0;
  let index = firstContentIndex + 1;
  while (index < requestHeaderIndex) {
    if (lines[index]?.trim() === "") {
      index += 1;
      continue;
    }

    const heading = lines[index]?.trim() ?? "";
    const inlineAttachment = heading.match(/^##\s+.+?:\s+(.+)$/);
    if (
      inlineAttachment?.[1] &&
      isAbsoluteCodexAttachmentPath(inlineAttachment[1].trim())
    ) {
      attachmentCount += 1;
      index += 1;
      continue;
    }

    if (!/^##\s+.+?:$/.test(heading)) return text;
    let pathIndex = index + 1;
    while (pathIndex < requestHeaderIndex && lines[pathIndex]?.trim() === "") {
      pathIndex += 1;
    }
    const path = lines[pathIndex]?.trim() ?? "";
    if (!isAbsoluteCodexAttachmentPath(path)) return text;
    attachmentCount += 1;
    index = pathIndex + 1;
  }

  const body = lines
    .slice(requestHeaderIndex + 1)
    .join("\n")
    .replace(
      /(?:^|\n)<image\b[^>\n]*\bpath=(?:"[^"\n]+"|'[^'\n]+')[^>\n]*>\s*(?:\n)?<\/image>(?=\n|$)/gi,
      "\n",
    )
    .trim();
  return attachmentCount > 0 && body ? body : text;
}

export function sanitizeCodexAssistantMessageText(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n");
  const withoutMemoryCitations = normalized.replace(
    /(?:^|\n)[ \t]*<oai-mem-citation>[ \t]*\n[\s\S]*?\n[ \t]*<\/oai-mem-citation>[ \t]*(?=\n|$)/g,
    "\n",
  );
  return withoutMemoryCitations
    .split("\n")
    .filter((line) => !CODEX_INTERNAL_DIRECTIVE.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type CodexAccessMode =
  | "follow-desktop"
  | "request-approval"
  | "auto"
  | "full-access"
  | "custom";
export type CodexCustomFileAccess =
  | "read-only"
  | "workspace-write"
  | "full-access";
export type CodexCustomApprovalPolicy = "on-request" | "never";
export interface CodexCustomPermissions {
  fileAccess: CodexCustomFileAccess;
  approvalPolicy: CodexCustomApprovalPolicy;
}
export const DEFAULT_CODEX_CUSTOM_PERMISSIONS: CodexCustomPermissions = {
  fileAccess: "workspace-write",
  approvalPolicy: "on-request",
};
export type CodexModelReasoningEffort =
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";
export type CodexReasoningEffort =
  | "follow-desktop"
  | CodexModelReasoningEffort;
export type CodexSpeed = "follow-desktop" | "standard" | "fast";
export type CodexRuntimeStatus = "unavailable" | "idle" | "running";

export const CODEX_MODEL_OPTIONS = [
  {
    id: "gpt-5.6-sol",
    label: "5.6 Sol",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    supportsFast: true,
    inputModalities: ["text", "image"],
  },
  {
    id: "gpt-5.6-terra",
    label: "5.6 Terra",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    supportsFast: true,
    inputModalities: ["text", "image"],
  },
  {
    id: "gpt-5.6-luna",
    label: "5.6 Luna",
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    supportsFast: true,
    inputModalities: ["text", "image"],
  },
  {
    id: "gpt-5.5",
    label: "5.5",
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    supportsFast: true,
    inputModalities: ["text", "image"],
  },
  {
    id: "gpt-5.4",
    label: "5.4",
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    supportsFast: true,
    inputModalities: ["text", "image"],
  },
  {
    id: "gpt-5.4-mini",
    label: "5.4 Mini",
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    supportsFast: false,
    inputModalities: ["text", "image"],
  },
  {
    id: "gpt-5.3-codex-spark",
    label: "5.3 Codex Spark",
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    supportsFast: false,
    inputModalities: ["text"],
  },
] as const;

export type CodexModelId = (typeof CODEX_MODEL_OPTIONS)[number]["id"];

export function normalizeCodexModelId(value: string): CodexModelId | null {
  const option = CODEX_MODEL_OPTIONS.find(
    (candidate) => candidate.id === value || candidate.label === value,
  );
  return option?.id ?? null;
}

export function getCodexModelOption(model: CodexModelId | null | undefined) {
  if (!model) return null;
  return CODEX_MODEL_OPTIONS.find((candidate) => candidate.id === model) ?? null;
}

export function codexModelSupportsReasoningEffort(
  model: CodexModelId | null | undefined,
  effort: CodexReasoningEffort,
): boolean {
  if (!model || effort === "follow-desktop") return true;
  const option = getCodexModelOption(model);
  return Boolean(
    option?.reasoningEfforts.some(
      (candidate) => candidate === (effort as CodexModelReasoningEffort),
    ),
  );
}

export function codexModelSupportsFast(
  model: CodexModelId | null | undefined,
): boolean {
  return getCodexModelOption(model)?.supportsFast ?? true;
}

export function codexModelSupportsImages(
  model: CodexModelId | null | undefined,
): boolean {
  const option = getCodexModelOption(model);
  return option ? option.inputModalities.some((modality) => modality === "image") : true;
}

export interface CodexPromptOptions {
  accessMode: CodexAccessMode;
  customPermissions: CodexCustomPermissions | null;
  model: CodexModelId | null;
  reasoningEffort: CodexReasoningEffort;
  speed: CodexSpeed;
  planMode: boolean;
}

export const DEFAULT_CODEX_PROMPT_OPTIONS: CodexPromptOptions = {
  accessMode: "follow-desktop",
  customPermissions: null,
  model: null,
  reasoningEffort: "follow-desktop",
  speed: "follow-desktop",
  planMode: false,
};

