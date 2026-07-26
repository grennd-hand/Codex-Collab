export const PROTOCOL_VERSION = "v1" as const;

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

export type MemberRole = "owner" | "editor";
export type MemberStatus = "pending" | "approved" | "rejected" | "revoked";
export type WorkspaceFileAccess = "read-only" | "workspace-write";
export type RoomStatus = "open" | "closed";
export type MessageKind = "chat" | "codex_prompt" | "codex_stop" | "system";
export type MessageDeliveryStatus = "queued" | "submitted" | "completed" | "failed";
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

export interface MessageAttachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
}

export interface MessageAttachmentInput {
  name: string;
  mediaType: string;
  size: number;
  dataBase64: string;
}

export const MAX_MESSAGE_ATTACHMENT_COUNT = 8;
export const MAX_MESSAGE_ATTACHMENT_SIZE = 4_000_000;
export const MAX_MESSAGE_ATTACHMENT_TOTAL_SIZE = 6_000_000;

const PUBLISHABLE_WORKSPACE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".cfg",
  ".conf",
  ".go",
  ".h",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".md",
  ".mjs",
  ".mts",
  ".ps1",
  ".py",
  ".rs",
  ".rules",
  ".scss",
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

const PRIVATE_WORKSPACE_FILE_NAMES = new Set([
  ".netrc",
  ".npmrc",
  ".pypirc",
  "auth.json",
  "auth.toml",
  "cookies.json",
  "credentials.json",
  "id_ed25519",
  "id_rsa",
  "history.jsonl",
  "secrets.json",
  "state.json",
  "tokens.json",
]);

const CODEX_NON_CONFIG_DIRECTORIES = new Set([
  "archived_sessions",
  "attachments",
  "cache",
  "history",
  "logs",
  "memories",
  "projects",
  "rollouts",
  "sessions",
  "shell_snapshots",
  "threads",
  "tmp",
]);

function workspacePathName(path: string): string {
  return path.replaceAll("\\", "/").split("/").at(-1) ?? "";
}

export function isPublishableWorkspacePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const segments = normalized.split("/");
  const name = workspacePathName(normalized);
  if (
    segments.includes(".codex") ||
    segments.includes(".codex-collab") ||
    segments.includes(".git") ||
    segments.includes(".runtime-data") ||
    name === ".env" ||
    name.startsWith(".env.")
  ) {
    return false;
  }
  if (
    PRIVATE_WORKSPACE_FILE_NAMES.has(name) ||
    name.startsWith("service-account")
  ) {
    return false;
  }
  const dot = name.lastIndexOf(".");
  return dot >= 0 && PUBLISHABLE_WORKSPACE_EXTENSIONS.has(name.slice(dot));
}

export function codexConfigRelativePath(path: string): string | null {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (segments[0]?.toLowerCase() !== ".codex" || segments.length < 2) {
    return null;
  }
  return segments.slice(1).join("/");
}

export function isPublishableCodexConfigPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  const segments = normalized.split("/");
  const name = workspacePathName(normalized);
  if (
    segments.some((segment) => CODEX_NON_CONFIG_DIRECTORIES.has(segment)) ||
    name === ".env" ||
    name.startsWith(".env.") ||
    PRIVATE_WORKSPACE_FILE_NAMES.has(name) ||
    name.startsWith("service-account")
  ) {
    return false;
  }
  const dot = name.lastIndexOf(".");
  return dot >= 0 && PUBLISHABLE_WORKSPACE_EXTENSIONS.has(name.slice(dot));
}

export function containsLikelySecret(content: string): boolean {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content)) return true;
  if (
    /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/.test(
      content,
    )
  ) {
    return true;
  }
  return /(?:^|\n)\s*(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|SECRET_KEY)\s*=\s*["']?(?!example|placeholder|change-me)[^\s"'#]{12,}/i.test(
    content,
  );
}

function normalizeCollabIgnorePath(path: string): string {
  return path
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/^\/+|\/+$/g, "");
}

export function isWorkspacePathIgnored(
  path: string,
  ignoredPaths: readonly string[],
  caseInsensitive = false,
): boolean {
  const normalizeCase = (value: string) =>
    caseInsensitive ? value.toLocaleLowerCase("en-US") : value;
  const normalizedPath = normalizeCase(normalizeCollabIgnorePath(path));
  return ignoredPaths.some((ignoredPath) => {
    const ignored = normalizeCase(normalizeCollabIgnorePath(ignoredPath));
    return Boolean(
      ignored &&
        (normalizedPath === ignored || normalizedPath.startsWith(`${ignored}/`)),
    );
  });
}

export interface Session {
  id: string;
  name: string;
  ownerMemberId: string;
  roomStatus: RoomStatus;
  createdAt: string;
}

export interface UpdateRoomStatusRequest {
  roomStatus: RoomStatus;
}

export interface UpdateRoomStatusResponse {
  session: Session;
}

export interface Member {
  id: string;
  sessionId: string;
  displayName: string;
  deviceLabel: string | null;
  role: MemberRole;
  status: MemberStatus;
  workspaceFileAccess: WorkspaceFileAccess;
  createdAt: string;
  approvedAt: string | null;
}

export interface Account {
  id: string;
  displayName: string;
  createdAt: string;
}

export interface AccountRoom {
  session: Session;
  member: Member;
  lastUsedAt: string | null;
}

export interface AccountProfileResponse {
  account: Account;
  rooms: AccountRoom[];
  csrfToken: string;
}

export interface RestoreAccountRoomResponse {
  session: Session;
  member: Member;
  memberToken: string;
}

export interface Message {
  id: string;
  sessionId: string;
  senderMemberId: string;
  senderDisplayName: string;
  kind: MessageKind;
  body: string;
  attachments: MessageAttachment[];
  codexOptions: CodexPromptOptions | null;
  deliveryStatus: MessageDeliveryStatus | null;
  codexTurnId: string | null;
  workspaceThreadId: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface CreateSessionRequest {
  name: string;
  ownerDisplayName: string;
  deviceLabel?: string;
}

export interface CreateSessionResponse {
  session: Session;
  owner: Member;
  memberToken: string;
}

export interface CreateInviteRequest {
  expiresInMinutes?: number;
  maxUses?: number;
}

export interface CreateInviteResponse {
  sessionId: string;
  inviteToken: string;
  inviteLink: string;
  expiresAt: string;
}

export interface JoinInviteRequest {
  inviteToken: string;
  displayName: string;
  deviceLabel?: string;
}

export interface JoinInviteResponse {
  session: Session;
  member: Member;
  memberToken: string;
}

export interface CodexThreadCatalogEntry {
  id: string;
  name: string | null;
  preview: string;
  updatedAt: number | null;
}

export interface CodexRecordEntry {
  id: string;
  role: "user" | "assistant" | "reasoning" | "command";
  phase?: "commentary" | "final_answer";
  text: string;
  createdAt: string | null;
}

export interface WorkspaceFile {
  path: string;
  size: number;
  modifiedAt: string;
  sha256: string;
}

export interface WorkspaceFileContent extends WorkspaceFile {
  content: string;
}

export type WorkspaceFileOperationKind = "read" | "write";
export type WorkspaceFileOperationStatus =
  | "queued"
  | "processing"
  | "completed"
  | "failed";

export interface WorkspaceFileOperation {
  id: string;
  sessionId: string;
  requestedByMemberId: string;
  requestedByDisplayName: string;
  hostGeneration: string;
  kind: WorkspaceFileOperationKind;
  path: string;
  expectedSha256: string | null;
  status: WorkspaceFileOperationStatus;
  resultFileMetadata: WorkspaceFile | null;
  resultFile: WorkspaceFileContent | null;
  errorCode: string | null;
  errorMessage: string | null;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface WorkspaceFileOperationClaim
  extends Omit<WorkspaceFileOperation, "expectedSha256"> {
  /** Write preconditions are withheld until the current host confirms the lease. */
  expectedSha256: null;
  leaseId: string;
  leaseExpiresAt: string;
}

export interface WorkspaceFileOperationConfirmation
  extends Omit<WorkspaceFileOperationClaim, "expectedSha256"> {
  expectedSha256: string | null;
  requestContent: string | null;
}

export interface WorkspaceFileOperationEvent {
  operationId: string;
  requestedByMemberId: string;
  status: WorkspaceFileOperationStatus;
}

export type CreateWorkspaceFileOperationRequest =
  | {
      kind: "read";
      path: string;
    }
  | {
      kind: "write";
      path: string;
      content: string;
      /** SHA-256 observed for the existing shared file. New-file creation is disabled. */
      expectedSha256: string;
    };

export interface UpdateMemberWorkspaceFileAccessRequest {
  workspaceFileAccess: WorkspaceFileAccess;
}

export interface WorkspaceSummary {
  hostConnected: boolean;
  hostDeviceLabel: string | null;
  rootLabel: string | null;
  threads: CodexThreadCatalogEntry[];
  selectedThreadId: string | null;
  selectedThread: CodexThreadCatalogEntry | null;
  history: CodexRecordEntry[];
  files: WorkspaceFile[];
  codexRuntimeStatus: CodexRuntimeStatus;
  syncedAt: string | null;
}

export interface CreateHostPairingResponse {
  sessionId: string;
  pairingToken: string;
  expiresAt: string;
}

export interface ClaimHostPairingResponse {
  session: Session;
  owner: Member;
  memberToken: string;
}

export interface RealtimeEnvelope {
  type:
    | "ready"
    | "session.updated"
    | "member.updated"
    | "message.created"
    | "workspace.updated"
    | "file.operation.updated";
  sessionId: string;
  payload: unknown;
  sentAt: string;
}

export interface RealtimeTicketResponse {
  ticket: string;
  expiresAt: string;
}

export class ProtocolError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

export function requiredString(value: unknown, field: string, maxLength = 10_000): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProtocolError(400, "invalid_request", `${field} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new ProtocolError(400, "invalid_request", `${field} is too long`);
  }
  return normalized;
}

export function optionalInteger(
  value: unknown,
  fallback: number,
  field: string,
  min: number,
  max: number,
): number {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new ProtocolError(400, "invalid_request", `${field} must be between ${min} and ${max}`);
  }
  return value as number;
}
