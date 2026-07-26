import {
  Avatar,
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  FluentProvider,
  Input,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Select,
  Skeleton,
  SkeletonItem,
  Spinner,
  Switch,
  Textarea,
  createDarkTheme,
  createLightTheme,
  type BrandVariants,
} from "@fluentui/react-components";
import {
  ArrowDownloadRegular,
  ArrowSyncRegular,
  AttachRegular,
  BotRegular,
  CheckmarkCircleRegular,
  ChatRegular,
  ChatMultipleRegular,
  ChevronDownRegular,
  CopyRegular,
  DeleteRegular,
  DismissRegular,
  DocumentRegular,
  FolderOpenRegular,
  HomeRegular,
  HistoryRegular,
  KeyRegular,
  LockClosedRegular,
  MicRegular,
  PersonAddRegular,
  PersonAccountsRegular,
  SendRegular,
  SignOutRegular,
  StopRegular,
  WeatherMoonRegular,
  WeatherSunnyRegular,
} from "@fluentui/react-icons";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  AccountProfileResponse,
  AccountRoom,
  CodexAccessMode,
  CodexRecordEntry,
  CodexCustomApprovalPolicy,
  CodexCustomFileAccess,
  CodexModelId,
  CodexPromptOptions,
  CodexReasoningEffort,
  CodexRuntimeStatus,
  CodexSpeed,
  CreateInviteResponse,
  CreateHostPairingResponse,
  CreateSessionResponse,
  JoinInviteResponse,
  Member,
  Message,
  MessageAttachment,
  MessageAttachmentInput,
  MessageKind,
  RealtimeEnvelope,
  RealtimeTicketResponse,
  Session,
  WorkspaceFileContent,
  WorkspaceSummary,
} from "@codex-collab/protocol";
import {
  CODEX_MODEL_OPTIONS,
  DEFAULT_CODEX_CUSTOM_PERMISSIONS,
  codexModelSupportsFast,
  codexModelSupportsImages,
  codexModelSupportsReasoningEffort,
  getCodexModelOption,
  normalizeCodexModelId,
} from "@codex-collab/protocol";
import { copyText } from "./clipboard.js";
import {
  buildUnifiedTimeline,
  splitConversationMessages,
} from "./imported-timeline.js";
import {
  parseReadableBlocks,
  presentExecutionEntries,
  presentExecutionEntry,
  type ExecutionStatus,
  type ReadableExecution,
} from "./readable-output.js";
import {
  setupSubmissionMode,
  shouldRestoreCredential,
} from "./invite-session.js";
import {
  buildMemberIdentityMap,
  fallbackMemberIdentity,
} from "./member-identity.js";
import { isCredentialRejected, requestJson } from "./api-client.js";
import { ApiRequestError } from "./api-client.js";
import { compressImageFile } from "./image-compression.js";
import {
  linkAccountRoom,
  loadAccountProfile,
  logoutAccount,
  passkeysAvailable,
  registerPasskey,
  restoreAccountRoom,
  signInWithPasskey,
} from "./account-client.js";

const brand: BrandVariants = {
  10: "#02040C",
  20: "#07102D",
  30: "#0B1C52",
  40: "#11297A",
  50: "#1737A1",
  60: "#2047CB",
  70: "#2E5BFF",
  80: "#5378FF",
  90: "#7896FF",
  100: "#9BB1FF",
  110: "#B8C7FF",
  120: "#CFDAFF",
  130: "#E0E7FF",
  140: "#EDF1FF",
  150: "#F5F7FF",
  160: "#FBFCFF",
};

const lightTheme = createLightTheme(brand);
const darkTheme = createDarkTheme(brand);
const storageKey = "codexCollab";
const maxAttachmentCount = 8;
const maxAttachmentSize = 4_000_000;
const maxAttachmentTotalSize = 6_000_000;

type ThemeMode = "light" | "dark";
type ConnectionState = "ready" | "connecting" | "live" | "waiting" | "error";
type SessionExitReason = "manual" | "credential-rejected";
export type ComposerMode = "codex" | "chat";
export type CodexExecutionPhase = "idle" | "queued" | "running" | "stopping";
export type ComposerPrimaryAction = "send_chat" | "send_codex" | "stop_codex";

export function workspaceNeedsConversationLoad(
  workspace: Pick<WorkspaceSummary, "selectedThreadId" | "syncedAt"> | null,
): boolean {
  return Boolean(workspace?.selectedThreadId && !workspace.syncedAt);
}

export function codexExecutionPhase(
  messages: readonly Pick<Message, "kind" | "deliveryStatus">[],
  runtimeStatus: CodexRuntimeStatus | null | undefined,
): CodexExecutionPhase {
  let latestPromptIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.kind === "codex_prompt") {
      latestPromptIndex = index;
      break;
    }
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

interface SavedCredential {
  session: Session;
  member: Member;
  token: string;
}

interface ActivityItem {
  id: string;
  title: string;
  detail: string;
  createdAt: string;
  tone: "info" | "success" | "warning" | "danger";
}

interface PendingAttachment {
  id: string;
  file: File;
  originalSize?: number;
}

interface PreparedAttachmentBatch {
  attachments: PendingAttachment[];
  warnings: string[];
}

interface SpeechRecognitionResultLike {
  readonly length: number;
  readonly isFinal: boolean;
  readonly [index: number]: { transcript: string };
}

interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: {
    readonly length: number;
    readonly [index: number]: SpeechRecognitionResultLike;
  };
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

const defaultCodexOptions: CodexPromptOptions = {
  accessMode: "follow-desktop",
  customPermissions: null,
  model: null,
  reasoningEffort: "follow-desktop",
  speed: "follow-desktop",
  planMode: false,
};

const reasoningEffortOrder: Exclude<
  CodexReasoningEffort,
  "follow-desktop"
>[] = ["low", "medium", "high", "xhigh", "max", "ultra"];
const reasoningEffortLabels: Record<
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

export function normalizeCodexOptionsForUi(value: unknown): CodexPromptOptions {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const accessMode =
    typeof record.accessMode === "string" &&
    accessModes.has(record.accessMode as CodexAccessMode)
      ? (record.accessMode as CodexAccessMode)
      : defaultCodexOptions.accessMode;
  const model =
    typeof record.model === "string" ? normalizeCodexModelId(record.model) : null;
  let reasoningEffort =
    typeof record.reasoningEffort === "string" &&
    reasoningEfforts.has(record.reasoningEffort as CodexReasoningEffort)
      ? (record.reasoningEffort as CodexReasoningEffort)
      : defaultCodexOptions.reasoningEffort;
  let speed =
    typeof record.speed === "string" && speeds.has(record.speed as CodexSpeed)
      ? (record.speed as CodexSpeed)
      : defaultCodexOptions.speed;

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

function formatFileSize(size: number): string {
  if (size < 1_000) return `${size} B`;
  if (size < 1_000_000) return `${Math.round(size / 1_000)} KB`;
  return `${(size / 1_000_000).toFixed(1)} MB`;
}

function attachmentSizeLabel(attachment: PendingAttachment): string {
  return attachment.originalSize && attachment.originalSize > attachment.file.size
    ? `已压缩 ${formatFileSize(attachment.originalSize)} → ${formatFileSize(attachment.file.size)}`
    : formatFileSize(attachment.file.size);
}

async function prepareAttachmentBatch(files: readonly File[]): Promise<PreparedAttachmentBatch> {
  const attachments: PendingAttachment[] = [];
  const warnings: string[] = [];
  for (const file of files) {
    if (file.size === 0) {
      warnings.push(`空文件无法发送：${file.name}`);
      continue;
    }
    try {
      const prepared = await compressImageFile(file);
      attachments.push({
        id: crypto.randomUUID(),
        file: prepared.file,
        ...(prepared.compressed ? { originalSize: prepared.originalSize } : {}),
      });
    } catch {
      attachments.push({ id: crypto.randomUUID(), file });
      warnings.push(`图片压缩失败，已尝试保留原文件：${file.name}`);
    }
  }
  return { attachments, warnings };
}

function appendPendingAttachments(
  current: readonly PendingAttachment[],
  incoming: readonly PendingAttachment[],
): { attachments: PendingAttachment[]; warning: string | null } {
  const next = [...current];
  let warning: string | null = null;
  for (const attachment of incoming) {
    const file = attachment.file;
    if (file.size > maxAttachmentSize) {
      warning = attachment.originalSize
        ? `${file.name} 压缩后仍超过 4 MB 单文件限制`
        : `${file.name} 超过 4 MB 单文件限制`;
      continue;
    }
    if (
      next.some(
        (item) =>
          item.file.name === file.name &&
          item.file.size === file.size &&
          item.file.lastModified === file.lastModified,
      )
    ) {
      continue;
    }
    if (next.length >= maxAttachmentCount) {
      warning = "一次最多发送 8 个附件";
      break;
    }
    if (
      next.reduce((sum, item) => sum + item.file.size, 0) + file.size >
      maxAttachmentTotalSize
    ) {
      warning = "压缩后的附件总大小不能超过 6 MB";
      break;
    }
    next.push(attachment);
  }
  return { attachments: next, warning };
}

function renderInlineText(text: string): ReactNode[] {
  const pattern =
    /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
  return text.split(pattern).filter(Boolean).map((part, index) => {
    const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
    if (link) {
      return (
        <a
          href={link[2]}
          key={`${index}-${part}`}
          rel="noreferrer"
          target="_blank"
        >
          {link[1]}
        </a>
      );
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={`${index}-${part}`}>{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={`${index}-${part}`}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

function ReadableOutput({ text }: { text: string }) {
  const blocks = parseReadableBlocks(text);
  return (
    <div className="readable-output">
      {blocks.map((block, index) => {
        const key = `${block.kind}-${index}`;
        if (block.kind === "heading") {
          return block.level === 3 ? (
            <h4 key={key}>{renderInlineText(block.text)}</h4>
          ) : (
            <h3 className={`level-${block.level}`} key={key}>
              {renderInlineText(block.text)}
            </h3>
          );
        }
        if (block.kind === "unordered-list") {
          return (
            <ul key={key}>
              {block.items.map((item, itemIndex) => (
                <li key={`${itemIndex}-${item}`}>{renderInlineText(item)}</li>
              ))}
            </ul>
          );
        }
        if (block.kind === "ordered-list") {
          return (
            <ol key={key}>
              {block.items.map((item, itemIndex) => (
                <li key={`${itemIndex}-${item}`}>{renderInlineText(item)}</li>
              ))}
            </ol>
          );
        }
        if (block.kind === "quote") {
          return <blockquote key={key}>{renderInlineText(block.text)}</blockquote>;
        }
        if (block.kind === "code") {
          return (
            <div className="readable-code" key={key}>
              {block.language ? <span>{block.language}</span> : null}
              <pre>{block.text}</pre>
            </div>
          );
        }
        return <p key={key}>{renderInlineText(block.text)}</p>;
      })}
    </div>
  );
}

function executionStatusLabel(status: ExecutionStatus): string {
  switch (status) {
    case "running":
      return "正在运行";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    default:
      return "已记录";
  }
}

export interface ExecutionProcessPresentation {
  status: ExecutionStatus;
  title: string;
  detail: string;
  progress: string;
  defaultExpanded: boolean;
}

export function executionProcessPresentation(
  records: readonly Pick<ReadableExecution, "status" | "title">[],
  active = false,
): ExecutionProcessPresentation {
  const running = records.filter((record) => record.status === "running");
  const failed = records.filter((record) => record.status === "failed");
  const completedCount = records.filter((record) => record.status === "completed").length;
  const latestRunning = running.at(-1);

  if (running.length > 0) {
    return {
      status: "running",
      title: "正在执行",
      detail: latestRunning?.title ?? "正在等待当前步骤",
      progress: `${completedCount} / ${records.length} 已完成`,
      defaultExpanded: true,
    };
  }
  if (active) {
    return {
      status: "running",
      title: "正在执行",
      detail: "Codex 正在继续处理",
      progress:
        records.length > 0
          ? `已同步 ${records.length} 个步骤，等待下一步`
          : "正在等待首个执行步骤",
      defaultExpanded: true,
    };
  }
  if (failed.length > 0) {
    return {
      status: "failed",
      title: "任务过程有错误",
      detail: failed.at(-1)?.title ?? "请查看失败步骤",
      progress: `${failed.length} 个失败`,
      defaultExpanded: true,
    };
  }
  if (records.length > 0 && completedCount === records.length) {
    return {
      status: "completed",
      title: "任务过程",
      detail: "全部步骤已完成",
      progress: `${records.length} 个步骤`,
      defaultExpanded: false,
    };
  }
  return {
    status: "unknown",
    title: "任务过程",
    detail: "已记录执行活动",
    progress: `${records.length} 个步骤`,
    defaultExpanded: false,
  };
}

export function elapsedExecutionLabel(
  startedAt: string | null,
  currentTime = Date.now(),
): string | null {
  if (!startedAt) return null;
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started) || started > currentTime) return null;
  const totalSeconds = Math.max(0, Math.floor((currentTime - started) / 1_000));
  if (totalSeconds < 2) return "刚刚开始";
  if (totalSeconds < 60) return `已运行 ${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `已运行 ${minutes} 分 ${seconds} 秒`;
  const hours = Math.floor(minutes / 60);
  return `已运行 ${hours} 小时 ${minutes % 60} 分`;
}

function ExecutionElapsedTime({ startedAt }: { startedAt: string }) {
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  useEffect(() => {
    setCurrentTime(Date.now());
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const label = elapsedExecutionLabel(startedAt, currentTime);
  return label ? <span>{label}</span> : null;
}

function ExecutionStatusIcon({
  status,
  fallback,
}: {
  status: ExecutionStatus;
  fallback: "command" | "reasoning";
}) {
  if (status === "running") return <Spinner size="tiny" />;
  if (status === "completed") return <CheckmarkCircleRegular />;
  if (status === "failed") return <DismissRegular />;
  return fallback === "command" ? <DocumentRegular /> : <HistoryRegular />;
}

function ExecutionStepCard({
  record,
  compact = false,
}: {
  record: ReadableExecution;
  compact?: boolean;
}) {
  const [detailsOpen, setDetailsOpen] = useState(
    record.status === "running" || record.status === "failed",
  );

  useEffect(() => {
    setDetailsOpen(record.status === "running" || record.status === "failed");
  }, [record.status]);

  return (
    <article
      className={`execution-step ${record.role} ${record.status}${compact ? " compact" : ""}`}
    >
      <div className="execution-step-marker" aria-hidden="true">
        <ExecutionStatusIcon status={record.status} fallback={record.role} />
      </div>
      <div className="execution-step-content">
        <header>
          <div>
            <strong>{record.title}</strong>
            <span className={`execution-state ${record.status}`}>
              {executionStatusLabel(record.status)}
            </span>
          </div>
          {record.createdAt ? (
            <time dateTime={record.createdAt}>{timeLabel(record.createdAt)}</time>
          ) : null}
        </header>
        <p className="execution-step-summary">{record.summary}</p>
        {record.role === "reasoning" && record.input ? (
          <ReadableOutput text={record.input} />
        ) : null}
        {record.role === "reasoning" && record.sourceText ? (
          <details className="execution-details reasoning-source">
            <summary>
              <span>查看 Codex 原始摘要</span>
              <small>内容可能为英文</small>
            </summary>
            <div className="execution-detail-body">
              <div className="execution-output visible">
                <span>原始摘要</span>
                <pre>{record.sourceText}</pre>
              </div>
            </div>
          </details>
        ) : null}
        {record.role === "command" && (record.input || record.output) ? (
          <details
            className="execution-details"
            open={detailsOpen}
          >
            <summary
              onClick={(event) => {
                event.preventDefault();
                setDetailsOpen((current) => !current);
              }}
            >
              <span>
                {record.status === "running"
                  ? "查看正在执行的内容"
                  : record.status === "failed"
                    ? "查看失败详情"
                    : "查看执行详情"}
              </span>
              {record.outputLineCount > 0 ? (
                <small>{record.outputLineCount} 行输出</small>
              ) : null}
            </summary>
            <div className="execution-detail-body">
              {record.input ? (
                <div className="execution-input">
                  <span>命令</span>
                  <pre>{record.input}</pre>
                </div>
              ) : null}
              {record.output ? (
                <div className="execution-output visible">
                  <span>输出</span>
                  <pre>{record.output}</pre>
                </div>
              ) : null}
            </div>
          </details>
        ) : null}
      </div>
    </article>
  );
}

export function ExecutionProcess({
  entries,
  active = false,
}: {
  entries: CodexRecordEntry[];
  active?: boolean;
}) {
  const records = presentExecutionEntries(entries, active);
  const presentation = executionProcessPresentation(records, active);
  const [expanded, setExpanded] = useState(presentation.defaultExpanded);
  const contentId = useId();
  const runningStartedAt =
    presentation.status === "running"
      ? (records.find((record) => record.createdAt)?.createdAt ?? null)
      : null;

  useEffect(() => {
    setExpanded(presentation.defaultExpanded);
  }, [presentation.defaultExpanded, presentation.status]);
  return (
    <section
      className={`execution-process ${presentation.status} ${expanded ? "expanded" : "collapsed"}`}
      aria-label="任务过程"
    >
      <span className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {presentation.title}：{presentation.detail}，{presentation.progress}
      </span>
      <header className="execution-process-heading">
        <button
          type="button"
          aria-controls={contentId}
          aria-expanded={expanded}
          aria-label={`${presentation.title}：${presentation.detail}，${presentation.progress}，${
            expanded ? "折叠任务过程" : "展开任务过程"
          }`}
          onClick={() => setExpanded((current) => !current)}
        >
          <span className="execution-process-status-icon" aria-hidden="true">
            <ExecutionStatusIcon status={presentation.status} fallback="reasoning" />
          </span>
          <span className="execution-process-title">
            <strong>{presentation.title}</strong>
            <span>{presentation.detail}</span>
          </span>
          <span className="execution-process-meta">
            {runningStartedAt ? <ExecutionElapsedTime startedAt={runningStartedAt} /> : null}
            <span>{presentation.progress}</span>
          </span>
          <ChevronDownRegular className="execution-process-chevron" aria-hidden="true" />
        </button>
      </header>
      {expanded ? (
        <div className="execution-step-list" id={contentId}>
          {records.map((record) => (
            <ExecutionStepCard key={`codex-${record.id}`} record={record} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取附件：${file.name}`));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error(`无法读取附件：${file.name}`));
        return;
      }
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

async function serializeAttachment(
  attachment: PendingAttachment,
): Promise<MessageAttachmentInput> {
  return {
    name: attachment.file.name,
    mediaType: attachment.file.type || "application/octet-stream",
    size: attachment.file.size,
    dataBase64: await fileToBase64(attachment.file),
  };
}

async function fetchMessageAttachment(
  sessionId: string,
  messageId: string,
  attachmentId: string,
  token: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const response = await fetch(
    `/v1/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(
      messageId,
    )}/attachments/${encodeURIComponent(attachmentId)}`,
    {
      headers: { authorization: `Bearer ${token}` },
      signal,
    },
  );
  if (!response.ok) {
    throw new Error(`附件读取失败（HTTP ${response.status}）`);
  }
  return response.blob();
}

function PeerChatAttachment(props: {
  sessionId: string;
  messageId: string;
  attachment: MessageAttachment;
  token: string;
  onError(error: unknown): void;
}) {
  const { sessionId, messageId, attachment, token, onError } = props;
  const isImage = attachment.mediaType.startsWith("image/");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (!isImage) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    void fetchMessageAttachment(
      sessionId,
      messageId,
      attachment.id,
      token,
      controller.signal,
    )
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        setPreviewUrl(objectUrl);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setPreviewFailed(true);
        onError(error);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.id, isImage, messageId, onError, sessionId, token]);

  const download = async () => {
    setDownloading(true);
    try {
      const blob = await fetchMessageAttachment(
        sessionId,
        messageId,
        attachment.id,
        token,
      );
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = attachment.name;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    } catch (error) {
      onError(error);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className={`peer-chat-attachment ${isImage ? "image" : "file"}`}>
      {isImage ? (
        <div className="peer-chat-image-preview">
          {previewUrl ? (
            <img src={previewUrl} alt={attachment.name} />
          ) : previewFailed ? (
            <span>图片预览不可用</span>
          ) : (
            <Skeleton aria-label="正在加载图片预览">
              <SkeletonItem />
            </Skeleton>
          )}
        </div>
      ) : null}
      <div className="peer-chat-attachment-row">
        <AttachRegular aria-hidden="true" />
        <div>
          <strong title={attachment.name}>{attachment.name}</strong>
          <small>{formatFileSize(attachment.size)}</small>
        </div>
        <Button
          type="button"
          appearance="subtle"
          size="small"
          icon={<ArrowDownloadRegular />}
          disabled={downloading}
          title={`下载 ${attachment.name}`}
          aria-label={`下载 ${attachment.name}`}
          onClick={() => void download()}
        />
      </div>
    </div>
  );
}

function deliveryStatusLabel(message: Message): string | null {
  if (message.kind !== "codex_prompt" && message.kind !== "codex_stop") return null;
  if (message.kind === "codex_stop") {
    if (message.deliveryStatus === "submitted") return "停止中";
    if (message.deliveryStatus === "completed") return "已停止";
    if (message.deliveryStatus === "failed") return "停止失败";
    return "停止排队中";
  }
  if (message.deliveryStatus === "submitted") return "执行中";
  if (message.deliveryStatus === "completed") return "执行完成";
  if (message.deliveryStatus === "failed") return "执行失败";
  return "排队中";
}

function loadCredential(): SavedCredential | null {
  const saved = sessionStorage.getItem(storageKey);
  if (!saved) {
    return null;
  }
  try {
    const parsed = JSON.parse(saved) as SavedCredential;
    if (!parsed.session?.id || !parsed.member?.id || !parsed.token) {
      throw new Error("invalid saved session");
    }
    return parsed;
  } catch {
    sessionStorage.removeItem(storageKey);
    return null;
  }
}

function timeLabel(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function recordRoleLabel(role: WorkspaceSummary["history"][number]["role"]): string {
  if (role === "user") return "用户";
  if (role === "assistant") return "Codex";
  if (role === "reasoning") return "推理摘要";
  return "命令执行";
}

function deviceLabel(): string {
  return navigator.platform || "Web device";
}

function inviteTokenFromLocation(): string {
  const parameters = new URLSearchParams(window.location.hash.slice(1));
  return parameters.get("invite")?.trim() ?? "";
}

function inviteLinkForCurrentOrigin(inviteToken: string): string {
  const url = new URL("/", window.location.origin);
  url.hash = new URLSearchParams({ invite: inviteToken }).toString();
  return url.toString();
}

function isLoopbackOrigin(): boolean {
  return (
    window.location.hostname === "127.0.0.1" ||
    window.location.hostname === "localhost" ||
    window.location.hostname === "::1"
  );
}

export function App() {
  const initialInviteToken = useMemo(inviteTokenFromLocation, []);
  const initialCredential = useMemo(
    () => (shouldRestoreCredential(initialInviteToken) ? loadCredential() : null),
    [initialInviteToken],
  );
  const [credential, setCredential] = useState<SavedCredential | null>(initialCredential);
  const [credentialValidated, setCredentialValidated] = useState(!initialCredential);
  const [members, setMembers] = useState<Member[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [activities, setActivities] = useState<ActivityItem[]>([
    {
      id: crypto.randomUUID(),
      title: "Relay 已启动",
      detail: "等待协作会话",
      createdAt: new Date().toISOString(),
      tone: "info",
    },
  ]);
  const [connection, setConnection] = useState<ConnectionState>(
    initialCredential?.member.status === "pending" ? "waiting" : "ready",
  );
  const [loading, setLoading] = useState(false);
  const [conversationLoading, setConversationLoading] = useState(
    initialCredential?.member.status === "approved",
  );
  const [error, setError] = useState<string | null>(null);
  const [credentialNotice, setCredentialNotice] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(!initialCredential);
  const [accountProfile, setAccountProfile] =
    useState<AccountProfileResponse | null>(null);
  const [accountChecking, setAccountChecking] = useState(true);
  const [accountDialogOpen, setAccountDialogOpen] = useState(false);
  const [accountDisplayName, setAccountDisplayName] = useState("Owner");
  const [accountSubmitting, setAccountSubmitting] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [restoringRoomId, setRestoringRoomId] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspaceSummary, setWorkspaceSummary] = useState<WorkspaceSummary | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [pairingToken, setPairingToken] = useState("");
  const [pairingExpiresAt, setPairingExpiresAt] = useState("");
  const [pairingCopied, setPairingCopied] = useState(false);
  const [selectedFile, setSelectedFile] = useState<WorkspaceFileContent | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [inviteLink, setInviteLink] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [displayName, setDisplayName] = useState(initialInviteToken ? "" : "Owner");
  const [roomName, setRoomName] = useState("Codex shared task");
  const [joinToken, setJoinToken] = useState(initialInviteToken);
  const [draft, setDraft] = useState("");
  const [chatDraft, setChatDraft] = useState("");
  const [pendingChatAttachments, setPendingChatAttachments] = useState<
    PendingAttachment[]
  >([]);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [preparingChatAttachments, setPreparingChatAttachments] = useState(false);
  const [preparingCodexAttachments, setPreparingCodexAttachments] = useState(false);
  const [codexOptions, setCodexOptions] =
    useState<CodexPromptOptions>(defaultCodexOptions);
  const [membersExpanded, setMembersExpanded] = useState(true);
  const [dictating, setDictating] = useState(false);
  const [draggingChatFiles, setDraggingChatFiles] = useState(false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [messageStreamPinned, setMessageStreamPinned] = useState(true);
  const [roomStatusUpdating, setRoomStatusUpdating] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );
  const messageStreamRef = useRef<HTMLElement>(null);
  const messageStreamPinnedRef = useRef(true);
  const chatStreamRef = useRef<HTMLDivElement>(null);
  const inviteLinkRef = useRef<HTMLInputElement>(null);
  const pairingTokenRef = useRef<HTMLInputElement>(null);
  const chatInputRef = useRef<HTMLInputElement>(null);
  const codexTextareaRef = useRef<HTMLTextAreaElement>(null);
  const chatAttachmentInputRef = useRef<HTMLInputElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const attachmentPreparationEpochRef = useRef(0);
  const chatAttachmentPreparationBusyRef = useRef(false);
  const codexAttachmentPreparationBusyRef = useRef(false);
  const speechRecognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const loadedComposerKeyRef = useRef<string | null>(null);
  const linkedRoomKeyRef = useRef<string | null>(null);
  const workspaceRefreshSequenceRef = useRef(0);

  const session = credential?.session ?? null;
  const member = credential?.member ?? null;
  const token = credential?.token ?? null;
  const approved = member?.status === "approved";
  const roomOpen = session?.roomStatus !== "closed";
  const supportsPasskeys = useMemo(passkeysAvailable, []);
  const composerStorageKey = session ? `codexCollabComposer:${session.id}` : null;

  const pushActivity = useCallback(
    (
      title: string,
      detail: string,
      tone: ActivityItem["tone"] = "info",
    ) => {
      setActivities((current) =>
        [
          {
            id: crypto.randomUUID(),
            title,
            detail,
            tone,
            createdAt: new Date().toISOString(),
          },
          ...current,
        ].slice(0, 8),
      );
    },
    [],
  );

  const clearSessionState = useCallback(
    (reason: SessionExitReason) => {
      sessionStorage.removeItem(storageKey);
      setCredential(null);
      setCredentialValidated(true);
      setMembers([]);
      setMessages([]);
      setWorkspaceSummary(null);
      workspaceRefreshSequenceRef.current += 1;
      setConversationLoading(false);
      setLoading(false);
      setWorkspaceLoading(false);
      setWorkspaceOpen(false);
      setInviteOpen(false);
      setPairingToken("");
      setPairingExpiresAt("");
      setSelectedFile(null);
      setFileLoading(false);
      setInviteLink("");
      setCopied(false);
      setCopyFailed(false);
      setDraft("");
      setChatDraft("");
      setPendingChatAttachments([]);
      setPendingAttachments([]);
      attachmentPreparationEpochRef.current += 1;
      chatAttachmentPreparationBusyRef.current = false;
      codexAttachmentPreparationBusyRef.current = false;
      setPreparingChatAttachments(false);
      setPreparingCodexAttachments(false);
      setMessageStreamPinned(true);
      messageStreamPinnedRef.current = true;
      setJoinToken("");
      setError(null);
      setConnection("ready");
      setSetupOpen(true);
      if (reason === "credential-rejected") {
        const detail = "上次保存的会话凭据已失效，请重新创建会话或使用新的邀请加入。";
        setCredentialNotice(detail);
        pushActivity("需要重新连接", detail, "warning");
        return;
      }
      setCredentialNotice(null);
      pushActivity("已离开本机会话", "服务器数据未删除", "info");
    },
    [pushActivity],
  );

  const showError = useCallback(
    (caught: unknown) => {
      if (isCredentialRejected(caught)) {
        clearSessionState("credential-rejected");
        return;
      }
      const message = caught instanceof Error ? caught.message : "请求未完成";
      setError(message);
      setConnection("error");
      pushActivity("操作未完成", message, "danger");
    },
    [clearSessionState, pushActivity],
  );

  const showAttachmentError = useCallback(
    (caught: unknown) => {
      const message = caught instanceof Error ? caught.message : "附件读取失败";
      setError(message);
      pushActivity("附件读取失败", message, "warning");
    },
    [pushActivity],
  );

  const saveCredential = useCallback((next: SavedCredential) => {
    setCredential(next);
    sessionStorage.setItem(storageKey, JSON.stringify(next));
  }, []);

  const refreshAccount = useCallback(async () => {
    try {
      const profile = await loadAccountProfile();
      setAccountProfile(profile);
      setAccountDisplayName(profile.account.displayName);
      setDisplayName((current) =>
        current === "Owner" ? profile.account.displayName : current,
      );
      setAccountError(null);
      return profile;
    } catch (caught) {
      if (
        caught instanceof ApiRequestError &&
        caught.status === 401 &&
        caught.code === "account_required"
      ) {
        setAccountProfile(null);
        return null;
      }
      const message = caught instanceof Error ? caught.message : "账号状态无法读取";
      setAccountError(message);
      return null;
    } finally {
      setAccountChecking(false);
    }
  }, []);

  const authHeaders = useCallback(
    (includeJson = false): HeadersInit => ({
      authorization: `Bearer ${token ?? ""}`,
      ...(includeJson ? { "content-type": "application/json" } : {}),
    }),
    [token],
  );

  const addMessage = useCallback((next: Message) => {
    setMessages((current) => {
      const index = current.findIndex((message) => message.id === next.id);
      if (index === -1) return [...current, next];
      const updated = [...current];
      updated[index] = next;
      return updated;
    });
  }, []);

  useEffect(() => {
    void refreshAccount();
  }, [refreshAccount]);

  useEffect(() => {
    if (!accountProfile || !credential || !credentialValidated) return;
    if (
      credential.member.status === "rejected" ||
      credential.member.status === "revoked" ||
      accountProfile.rooms.some((room) => room.session.id === credential.session.id)
    ) {
      return;
    }
    const key = `${accountProfile.account.id}:${credential.session.id}:${credential.member.id}`;
    if (linkedRoomKeyRef.current === key) return;
    linkedRoomKeyRef.current = key;
    void linkAccountRoom(
      accountProfile,
      credential.session.id,
      credential.token,
    )
      .then((profile) => {
        setAccountProfile(profile);
        setAccountError(null);
        pushActivity("房间已保存", "下次登录后可从我的房间重新进入", "success");
      })
      .catch((caught: unknown) => {
        linkedRoomKeyRef.current = null;
        setAccountError(caught instanceof Error ? caught.message : "当前房间无法保存到账号");
      });
  }, [accountProfile, credential, credentialValidated, pushActivity]);

  useEffect(() => {
    if (!session || !token || credentialValidated) {
      return;
    }
    let stopped = false;
    setConnection("connecting");
    void requestJson<{ member: Member; session: Session }>(
      `/v1/sessions/${session.id}/me`,
      { headers: { authorization: `Bearer ${token}` } },
    )
      .then((result) => {
        if (stopped) {
          return;
        }
        saveCredential({
          session: result.session,
          member: result.member,
          token,
        });
        setCredentialValidated(true);
        setConnection(result.member.status === "pending" ? "waiting" : "connecting");
        setError(null);
      })
      .catch((caught: unknown) => {
        if (!stopped) {
          showError(caught);
        }
      });
    return () => {
      stopped = true;
    };
  }, [credentialValidated, saveCredential, session, showError, token]);

  const refreshWorkspace = useCallback(async () => {
    if (!session || !token || !approved) {
      return null;
    }
    const requestSequence = ++workspaceRefreshSequenceRef.current;
    const result = await requestJson<{ workspace: WorkspaceSummary }>(
      `/v1/sessions/${session.id}/workspace`,
      { headers: authHeaders() },
    );
    if (requestSequence !== workspaceRefreshSequenceRef.current) {
      return result.workspace;
    }
    setWorkspaceSummary(result.workspace);
    setConversationLoading(workspaceNeedsConversationLoad(result.workspace));
    setSelectedFile((current) =>
      current && !result.workspace.files.some((file) => file.path === current.path)
        ? null
        : current,
    );
    return result.workspace;
  }, [approved, authHeaders, session, token]);

  const refresh = useCallback(async () => {
    if (!session || !token || !approved) {
      return;
    }
    const workspaceRequestSequence = ++workspaceRefreshSequenceRef.current;
    setLoading(true);
    try {
      const [messageResult, memberResult, meResult, workspaceResult] = await Promise.all([
        requestJson<{ messages: Message[] }>(
          `/v1/sessions/${session.id}/messages`,
          { headers: authHeaders() },
        ),
        requestJson<{ members: Member[] }>(
          `/v1/sessions/${session.id}/members`,
          { headers: authHeaders() },
        ),
        requestJson<{ member: Member; session: Session }>(
          `/v1/sessions/${session.id}/me`,
          {
          headers: authHeaders(),
          },
        ),
        requestJson<{ workspace: WorkspaceSummary }>(
          `/v1/sessions/${session.id}/workspace`,
          { headers: authHeaders() },
        ),
      ]);
      setMessages(messageResult.messages);
      setMembers(memberResult.members);
      if (workspaceRequestSequence === workspaceRefreshSequenceRef.current) {
        setWorkspaceSummary(workspaceResult.workspace);
        setConversationLoading(workspaceNeedsConversationLoad(workspaceResult.workspace));
      }
      if (
        meResult.member.status !== member.status ||
        meResult.session.roomStatus !== session.roomStatus
      ) {
        saveCredential({
          session: meResult.session,
          member: meResult.member,
          token,
        });
      }
      setError(null);
    } catch (caught) {
      setConversationLoading(false);
      showError(caught);
    } finally {
      setLoading(false);
    }
  }, [approved, authHeaders, member, saveCredential, session, showError, token]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => {
      setThemeMode(event.matches ? "dark" : "light");
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
    document.documentElement.style.colorScheme = themeMode;
  }, [themeMode]);

  useEffect(() => {
    if (!composerStorageKey) return;
    if (loadedComposerKeyRef.current !== composerStorageKey) {
      loadedComposerKeyRef.current = composerStorageKey;
      try {
        const saved = JSON.parse(localStorage.getItem(composerStorageKey) ?? "{}") as {
          draft?: unknown;
          codexDraft?: unknown;
          chatDraft?: unknown;
          codexOptions?: unknown;
          composerMode?: unknown;
        };
        const legacyDraft = typeof saved.draft === "string" ? saved.draft : "";
        setDraft(
          typeof saved.codexDraft === "string"
            ? saved.codexDraft
            : saved.composerMode === "chat"
              ? ""
              : legacyDraft,
        );
        setChatDraft(
          typeof saved.chatDraft === "string"
            ? saved.chatDraft
            : saved.composerMode === "chat"
              ? legacyDraft
              : "",
        );
        if (
          saved.codexOptions &&
          typeof saved.codexOptions === "object" &&
          !Array.isArray(saved.codexOptions)
        ) {
          setCodexOptions(normalizeCodexOptionsForUi(saved.codexOptions));
        } else {
          setCodexOptions(defaultCodexOptions);
        }
      } catch {
        setDraft("");
        setChatDraft("");
        setCodexOptions(defaultCodexOptions);
      }
      setPendingChatAttachments([]);
      setPendingAttachments([]);
      return;
    }
    localStorage.setItem(
      composerStorageKey,
      JSON.stringify({ codexDraft: draft, chatDraft, codexOptions }),
    );
  }, [chatDraft, codexOptions, composerStorageKey, draft]);

  useEffect(
    () => () => {
      speechRecognitionRef.current?.stop();
    },
    [],
  );

  useEffect(() => {
    const stream = messageStreamRef.current;
    if (stream && messageStreamPinnedRef.current) {
      stream.scrollTop = stream.scrollHeight;
    }
    const chatStream = chatStreamRef.current;
    if (chatStream) {
      chatStream.scrollTop = chatStream.scrollHeight;
    }
  }, [
    messages,
    workspaceSummary?.codexRuntimeStatus,
    workspaceSummary?.history.length,
    workspaceSummary?.history.at(-1)?.text,
  ]);

  useEffect(() => {
    if (
      member?.role === "owner" &&
      members.some((current) => current.status === "pending")
    ) {
      setMembersExpanded(true);
    }
  }, [member?.role, members]);

  useEffect(() => {
    if (!approved || !credentialValidated) {
      return;
    }
    void refresh();
  }, [approved, credentialValidated, refresh]);

  useEffect(() => {
    if (!session || !token || !credentialValidated || member?.status !== "pending") {
      return;
    }
    let stopped = false;
    let timer: number | undefined;

    const checkApproval = async () => {
      try {
        const result = await requestJson<{ member: Member; session: Session }>(
          `/v1/sessions/${session.id}/me`,
          { headers: { authorization: `Bearer ${token}` } },
        );
        if (stopped) {
          return;
        }
        if (result.member.status === "approved") {
          setConversationLoading(true);
          saveCredential({
            session: result.session,
            member: result.member,
            token,
          });
          setConnection("connecting");
          setError(null);
          pushActivity("主人已批准", "实时协作已启用", "success");
          return;
        }
      } catch (caught) {
        if (!stopped) {
          showError(caught);
          if (isCredentialRejected(caught)) {
            return;
          }
        }
      }
      if (!stopped) {
        timer = window.setTimeout(checkApproval, 2000);
      }
    };

    void checkApproval();
    return () => {
      stopped = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [
    credentialValidated,
    member?.status,
    pushActivity,
    saveCredential,
    session,
    showError,
    token,
  ]);

  useEffect(() => {
    if (!session || !token || !approved || !credentialValidated) {
      return;
    }
    let stopped = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let reconnectAttempt = 0;
    let connecting = false;

    const scheduleReconnect = () => {
      if (stopped || reconnectTimer !== undefined) return;
      const base = Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempt, 5));
      const delay = Math.round(base * (0.8 + Math.random() * 0.4));
      reconnectAttempt += 1;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        void connect();
      }, delay);
    };

    const connect = async () => {
      if (stopped || connecting) return;
      connecting = true;
      setConnection("connecting");
      let ticket: string;
      try {
        ticket = (
          await requestJson<RealtimeTicketResponse>(
            `/v1/sessions/${encodeURIComponent(session.id)}/realtime-tickets`,
            {
              method: "POST",
              headers: authHeaders(true),
              body: "{}",
            },
          )
        ).ticket;
      } catch (caught) {
        connecting = false;
        if (stopped) return;
        if (
          isCredentialRejected(caught) ||
          (caught instanceof ApiRequestError && caught.status === 403)
        ) {
          showError(caught);
          return;
        }
        setConnection("error");
        scheduleReconnect();
        return;
      }
      connecting = false;
      if (stopped) return;
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const query = new URLSearchParams({ ticket });
      socket = new WebSocket(
        `${protocol}//${location.host}/v1/realtime?${query.toString()}`,
      );
      socket.addEventListener("open", () => {
        if (!stopped) {
          reconnectAttempt = 0;
          setConnection("live");
          setError(null);
        }
      });
      socket.addEventListener("message", (event) => {
        const envelope = JSON.parse(event.data as string) as RealtimeEnvelope;
        if (envelope.type === "message.created") {
          const next = envelope.payload as Message;
          addMessage(next);
          pushActivity("收到新消息", next.senderDisplayName, "info");
        }
        if (envelope.type === "member.updated") {
          const next = envelope.payload as Member;
          pushActivity("成员状态已变化", next.displayName, "success");
          void refresh();
        }
        if (envelope.type === "session.updated") {
          const next = envelope.payload as Session;
          saveCredential({ session: next, member, token });
          if (next.roomStatus === "closed") {
            setInviteOpen(false);
          }
          pushActivity(
            next.roomStatus === "open" ? "房间已开启" : "房间已关闭",
            next.roomStatus === "open"
              ? "成员可以继续发送消息和 Codex 指令"
              : "历史记录仍可查看，新的协作操作已暂停",
            next.roomStatus === "open" ? "success" : "warning",
          );
        }
        if (envelope.type === "workspace.updated") {
          pushActivity("共享工作区已更新", "Codex 记录或文件发生变化", "success");
          void refreshWorkspace().catch(showError);
        }
      });
      socket.addEventListener("close", (event) => {
        if (!stopped) {
          if (event.code === 4001) {
            setConnection("error");
            return;
          }
          setConnection("connecting");
          scheduleReconnect();
        }
      });
      socket.addEventListener("error", () => {
        if (!stopped) {
          setConnection("error");
        }
      });
    };

    void connect();
    return () => {
      stopped = true;
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
      }
      socket?.close();
    };
  }, [
    addMessage,
    approved,
    authHeaders,
    credentialValidated,
    member,
    pushActivity,
    refresh,
    refreshWorkspace,
    saveCredential,
    session,
    showError,
    token,
  ]);

  const authenticateAccount = async (mode: "register" | "signin") => {
    if (!supportsPasskeys) {
      setAccountError("当前页面不支持通行密钥。请使用 HTTPS 地址或本机 localhost 打开。 ");
      return;
    }
    if (mode === "register" && !accountDisplayName.trim()) {
      setAccountError("请先填写显示名称");
      return;
    }
    setAccountSubmitting(true);
    setAccountError(null);
    try {
      let profile =
        mode === "register"
          ? await registerPasskey(accountDisplayName.trim())
          : await signInWithPasskey();
      if (
        credential &&
        credentialValidated &&
        credential.member.status !== "rejected" &&
        credential.member.status !== "revoked" &&
        !profile.rooms.some((room) => room.session.id === credential.session.id)
      ) {
        profile = await linkAccountRoom(
          profile,
          credential.session.id,
          credential.token,
        );
      }
      setAccountProfile(profile);
      setAccountDisplayName(profile.account.displayName);
      setDisplayName(profile.account.displayName);
      linkedRoomKeyRef.current = null;
      setAccountDialogOpen(false);
      setSetupOpen(!credential);
      setCredentialNotice(null);
      pushActivity(
        mode === "register" ? "账号已创建" : "账号已登录",
        profile.rooms.length > 0 ? `可恢复 ${profile.rooms.length} 个房间` : "可以创建第一个房间",
        "success",
      );
    } catch (caught) {
      setAccountError(caught instanceof Error ? caught.message : "通行密钥操作未完成");
    } finally {
      setAccountSubmitting(false);
    }
  };

  const activateAccountRoom = async (room: AccountRoom) => {
    if (!accountProfile) return;
    setRestoringRoomId(room.session.id);
    setAccountError(null);
    try {
      const result = await restoreAccountRoom(
        accountProfile,
        room.session.id,
        deviceLabel(),
      );
      setMessages([]);
      setMembers([result.member]);
      setWorkspaceSummary(null);
      setSelectedFile(null);
      setInviteLink("");
      setPendingChatAttachments([]);
      setPendingAttachments([]);
      setCredentialValidated(true);
      setConversationLoading(result.member.status === "approved");
      loadedComposerKeyRef.current = null;
      saveCredential({
        session: result.session,
        member: result.member,
        token: result.memberToken,
      });
      setConnection(result.member.status === "pending" ? "waiting" : "connecting");
      setSetupOpen(false);
      setAccountDialogOpen(false);
      setError(null);
      pushActivity(
        "已进入保存的房间",
        result.member.status === "pending" ? "仍在等待主人批准" : result.session.name,
        result.member.status === "pending" ? "warning" : "success",
      );
      await refreshAccount();
    } catch (caught) {
      setAccountError(caught instanceof Error ? caught.message : "房间无法恢复");
    } finally {
      setRestoringRoomId(null);
    }
  };

  const signOutAccount = async () => {
    if (!accountProfile) return;
    setAccountSubmitting(true);
    setAccountError(null);
    try {
      await logoutAccount(accountProfile);
      if (composerStorageKey) localStorage.removeItem(composerStorageKey);
      setAccountProfile(null);
      linkedRoomKeyRef.current = null;
      setAccountDialogOpen(false);
      clearSessionState("manual");
      pushActivity("账号已退出", "本设备需要重新使用通行密钥登录", "info");
    } catch (caught) {
      setAccountError(caught instanceof Error ? caught.message : "账号退出未完成");
    } finally {
      setAccountSubmitting(false);
    }
  };

  const createSession = async () => {
    setSubmitting(true);
    try {
      const result = await requestJson<CreateSessionResponse>("/v1/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(accountProfile ? { "x-codex-csrf": accountProfile.csrfToken } : {}),
        },
        body: JSON.stringify({
          name: roomName,
          ownerDisplayName: displayName,
          deviceLabel: deviceLabel(),
        }),
      });
      setConversationLoading(true);
      saveCredential({
        session: result.session,
        member: result.owner,
        token: result.memberToken,
      });
      setCredentialValidated(true);
      setMembers([result.owner]);
      setSetupOpen(false);
      setConnection("connecting");
      setError(null);
      setCredentialNotice(null);
      pushActivity("共享任务已创建", "你是主人", "success");
      if (accountProfile) void refreshAccount();
    } catch (caught) {
      showError(caught);
    } finally {
      setSubmitting(false);
    }
  };

  const joinSession = async () => {
    setSubmitting(true);
    try {
      const result = await requestJson<JoinInviteResponse>("/v1/invites/join", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(accountProfile ? { "x-codex-csrf": accountProfile.csrfToken } : {}),
        },
        body: JSON.stringify({
          inviteToken: joinToken,
          displayName,
          deviceLabel: deviceLabel(),
        }),
      });
      saveCredential({
        session: result.session,
        member: result.member,
        token: result.memberToken,
      });
      setCredentialValidated(true);
      setMembers([result.member]);
      setSetupOpen(false);
      setConnection("waiting");
      setError(null);
      setCredentialNotice(null);
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      pushActivity("加入申请已发送", "等待主人批准", "warning");
      if (accountProfile) void refreshAccount();
    } catch (caught) {
      showError(caught);
    } finally {
      setSubmitting(false);
    }
  };

  const submitSetup = (event: React.FormEvent) => {
    event.preventDefault();
    if (!accountProfile) return;
    if (setupSubmissionMode(joinToken) === "join") {
      void joinSession();
      return;
    }
    void createSession();
  };

  const addChatAttachments = async (files: FileList | File[]) => {
    if (!roomOpen || chatAttachmentPreparationBusyRef.current) return;
    const incoming = Array.from(files);
    if (incoming.length === 0) return;
    const preparationEpoch = attachmentPreparationEpochRef.current;
    chatAttachmentPreparationBusyRef.current = true;
    setPreparingChatAttachments(true);
    try {
      const prepared = await prepareAttachmentBatch(incoming);
      if (preparationEpoch !== attachmentPreparationEpochRef.current) return;
      const merged = appendPendingAttachments(pendingChatAttachments, prepared.attachments);
      setPendingChatAttachments(merged.attachments);
      const warning = merged.warning ?? prepared.warnings.at(-1) ?? null;
      setError(warning);
    } finally {
      if (preparationEpoch === attachmentPreparationEpochRef.current) {
        chatAttachmentPreparationBusyRef.current = false;
        setPreparingChatAttachments(false);
      }
    }
  };

  const addAttachments = async (files: FileList | File[]) => {
    if (!roomOpen || codexAttachmentPreparationBusyRef.current) return;
    const incoming = Array.from(files);
    if (incoming.length === 0) return;
    const modelLabel = getCodexModelOption(codexOptions.model)?.label ?? "当前模型";
    let unsupportedWarning: string | null = null;
    const allowed = incoming.filter((file) => {
      if (file.type.startsWith("image/") && !codexModelSupportsImages(codexOptions.model)) {
        unsupportedWarning = `${modelLabel} 仅支持文本，不能添加图片：${file.name}`;
        return false;
      }
      return true;
    });
    if (allowed.length === 0) {
      setError(unsupportedWarning);
      return;
    }
    const preparationEpoch = attachmentPreparationEpochRef.current;
    codexAttachmentPreparationBusyRef.current = true;
    setPreparingCodexAttachments(true);
    try {
      const prepared = await prepareAttachmentBatch(allowed);
      if (preparationEpoch !== attachmentPreparationEpochRef.current) return;
      const merged = appendPendingAttachments(pendingAttachments, prepared.attachments);
      setPendingAttachments(merged.attachments);
      const warning =
        merged.warning ?? prepared.warnings.at(-1) ?? unsupportedWarning ?? null;
      setError(warning);
    } finally {
      if (preparationEpoch === attachmentPreparationEpochRef.current) {
        codexAttachmentPreparationBusyRef.current = false;
        setPreparingCodexAttachments(false);
      }
    }
  };

  const toggleDictation = () => {
    if (dictating) {
      speechRecognitionRef.current?.stop();
      return;
    }
    const speechWindow = window as unknown as {
      SpeechRecognition?: SpeechRecognitionConstructor;
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    };
    const Constructor =
      speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
    if (!Constructor) {
      setError("当前浏览器不支持听写");
      return;
    }
    const recognition = new Constructor();
    recognition.lang = "zh-CN";
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      const fragments: string[] = [];
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result?.[0]?.transcript.trim();
        if (result?.isFinal && transcript) fragments.push(transcript);
      }
      if (fragments.length > 0) {
        setDraft((current) =>
          `${current}${current && !/\s$/.test(current) ? " " : ""}${fragments.join(" ")}`,
        );
      }
    };
    recognition.onerror = () => {
      setError("听写未完成，请检查浏览器麦克风权限");
      setDictating(false);
    };
    recognition.onend = () => {
      setDictating(false);
      speechRecognitionRef.current = null;
    };
    speechRecognitionRef.current = recognition;
    setDictating(true);
    recognition.start();
  };

  const sendMessage = async (kind: MessageKind) => {
    const restoreComposerFocus = () => {
      const control =
        kind === "chat" ? chatInputRef.current : codexTextareaRef.current;
      restoreComposerControlFocus(control);
    };
    const trimmedDraft = kind === "chat" ? chatDraft.trim() : draft.trim();
    const body =
      kind === "codex_stop"
        ? "停止当前 Codex 任务"
        : kind === "chat"
          ? chatMessageBody(chatDraft, pendingChatAttachments.length)
          : trimmedDraft ||
          (kind === "codex_prompt" && pendingAttachments.length > 0
            ? "请处理所附文件。"
            : "");
    if (
      !session ||
      !token ||
      !body ||
      !approved ||
      (kind === "chat" && preparingChatAttachments) ||
      (kind === "codex_prompt" && preparingCodexAttachments) ||
      (!roomOpen && kind !== "codex_stop") ||
      kind === "system"
    ) {
      return;
    }
    if (kind === "codex_prompt") {
      const modelLabel = getCodexModelOption(codexOptions.model)?.label ?? "当前模型";
      if (
        pendingAttachments.some((attachment) =>
          attachment.file.type.startsWith("image/"),
        ) &&
        !codexModelSupportsImages(codexOptions.model)
      ) {
        setError(`${modelLabel} 仅支持文本，请移除图片后再发送`);
        restoreComposerFocus();
        return;
      }
      if (
        !codexModelSupportsReasoningEffort(
          codexOptions.model,
          codexOptions.reasoningEffort,
        )
      ) {
        setCodexOptions((current) => normalizeCodexOptionsForUi(current));
        setError(`${modelLabel} 不支持当前推理强度，已自动调整`);
        restoreComposerFocus();
        return;
      }
      if (
        codexOptions.speed === "fast" &&
        !codexModelSupportsFast(codexOptions.model)
      ) {
        setCodexOptions((current) => normalizeCodexOptionsForUi(current));
        setError(`${modelLabel} 不支持快速模式，已切换为标准速度`);
        restoreComposerFocus();
        return;
      }
    }
    setSubmitting(true);
    try {
      const attachments =
        kind === "codex_prompt"
          ? await Promise.all(pendingAttachments.map(serializeAttachment))
          : kind === "chat"
            ? await Promise.all(pendingChatAttachments.map(serializeAttachment))
            : [];
      const result = await requestJson<{ message: Message }>(
        `/v1/sessions/${session.id}/messages`,
        {
          method: "POST",
          headers: authHeaders(true),
          body: JSON.stringify({
            kind,
            body,
            attachments,
            codexOptions: kind === "codex_prompt" ? codexOptions : null,
          }),
        },
      );
      addMessage(result.message);
      if (kind === "codex_prompt") {
        setDraft("");
        setPendingAttachments([]);
        pushActivity("已加入 Codex 队列", "Host 将在后台直接提交", "info");
      } else if (kind === "codex_stop") {
        pushActivity("停止请求已排队", "Host 将在后台中断当前任务", "warning");
      } else {
        setChatDraft("");
        setPendingChatAttachments([]);
      }
      setError(null);
    } catch (caught) {
      showError(caught);
    } finally {
      setSubmitting(false);
      restoreComposerFocus();
    }
  };

  const approveMember = async (target: Member) => {
    if (!session) {
      return;
    }
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
      showError(caught);
    }
  };

  const createInvite = async () => {
    if (!session || !roomOpen) {
      return;
    }
    try {
      const result = await requestJson<CreateInviteResponse>(
        `/v1/sessions/${session.id}/invites`,
        {
          method: "POST",
          headers: authHeaders(true),
          body: JSON.stringify({ expiresInMinutes: 60, maxUses: 1 }),
        },
      );
      setInviteLink(inviteLinkForCurrentOrigin(result.inviteToken));
      setCopied(false);
      setCopyFailed(false);
      setInviteOpen(true);
      pushActivity("邀请已创建", "60 分钟内可使用一次", "success");
    } catch (caught) {
      showError(caught);
    }
  };

  const updateRoomStatus = async (nextOpen: boolean) => {
    if (!session || !member || !token || member.role !== "owner") {
      return;
    }
    setRoomStatusUpdating(true);
    try {
      const result = await requestJson<{ session: Session }>(
        `/v1/sessions/${session.id}/room-status`,
        {
          method: "PUT",
          headers: authHeaders(true),
          body: JSON.stringify({
            roomStatus: nextOpen ? "open" : "closed",
          }),
        },
      );
      saveCredential({ session: result.session, member, token });
      if (!nextOpen) {
        setInviteOpen(false);
      }
      setError(null);
    } catch (caught) {
      showError(caught);
    } finally {
      setRoomStatusUpdating(false);
    }
  };

  const copyInvite = async () => {
    const copiedSuccessfully = await copyText(inviteLink, inviteLinkRef.current ?? undefined);
    setCopied(copiedSuccessfully);
    setCopyFailed(!copiedSuccessfully);
    if (copiedSuccessfully) {
      pushActivity("邀请链接已复制", "可以发送给协作者", "success");
    } else {
      inviteLinkRef.current?.focus();
      inviteLinkRef.current?.select();
    }
  };

  const openWorkspace = async () => {
    setWorkspaceOpen(true);
    setWorkspaceLoading(true);
    try {
      await refreshWorkspace();
      setError(null);
    } catch (caught) {
      showError(caught);
    } finally {
      setWorkspaceLoading(false);
    }
  };

  const createHostPairing = async () => {
    if (!session || member?.role !== "owner") {
      return;
    }
    setWorkspaceLoading(true);
    try {
      const result = await requestJson<CreateHostPairingResponse>(
        `/v1/sessions/${session.id}/host-pairings`,
        {
          method: "POST",
          headers: authHeaders(true),
          body: JSON.stringify({ expiresInMinutes: 10 }),
        },
      );
      setPairingToken(result.pairingToken);
      setPairingExpiresAt(result.expiresAt);
      setPairingCopied(false);
      pushActivity("本机配对码已生成", "10 分钟内使用一次", "success");
    } catch (caught) {
      showError(caught);
    } finally {
      setWorkspaceLoading(false);
    }
  };

  const copyPairingToken = async () => {
    const copiedSuccessfully = await copyText(
      pairingToken,
      pairingTokenRef.current ?? undefined,
    );
    setPairingCopied(copiedSuccessfully);
    if (!copiedSuccessfully) {
      pairingTokenRef.current?.focus();
      pairingTokenRef.current?.select();
    }
  };

  const selectCodexThread = async (threadId: string) => {
    if (!session || !threadId || member?.role !== "owner") {
      return;
    }
    setWorkspaceLoading(true);
    setConversationLoading(true);
    setSelectedFile(null);
    try {
      const result = await requestJson<{ workspace: WorkspaceSummary }>(
        `/v1/sessions/${session.id}/workspace/selection`,
        {
          method: "PUT",
          headers: authHeaders(true),
          body: JSON.stringify({ threadId }),
        },
      );
      setWorkspaceSummary(result.workspace);
      setConversationLoading(workspaceNeedsConversationLoad(result.workspace));
      pushActivity("已选择 Codex 任务", "等待本机插件导入记录与文件", "success");
    } catch (caught) {
      setConversationLoading(false);
      showError(caught);
    } finally {
      setWorkspaceLoading(false);
    }
  };

  const openWorkspaceFile = async (path: string) => {
    if (!session) {
      return;
    }
    setFileLoading(true);
    try {
      const result = await requestJson<{ file: WorkspaceFileContent }>(
        `/v1/sessions/${session.id}/workspace/file?path=${encodeURIComponent(path)}`,
        { headers: authHeaders() },
      );
      setSelectedFile(result.file);
      setError(null);
    } catch (caught) {
      showError(caught);
    } finally {
      setFileLoading(false);
    }
  };

  const resetSession = () => {
    clearSessionState("manual");
  };

  const owner = members.find((item) => item.role === "owner");
  const status = connectionPresentation(connection, Boolean(session));
  const importedHistory = workspaceSummary?.history ?? [];
  const { chatMessages, codexMessages } = splitConversationMessages(messages);
  const codexTimeline = buildUnifiedTimeline(importedHistory, codexMessages);
  const hasCodexContent = importedHistory.length > 0 || codexMessages.length > 0;
  const pendingMemberCount = members.filter((item) => item.status === "pending").length;
  const memberIdentities = useMemo(() => buildMemberIdentityMap(members), [members]);
  const identityForMember = (memberId: string) =>
    memberIdentities.get(memberId) ?? fallbackMemberIdentity(memberId);
  const codexConfigFileCount =
    workspaceSummary?.files.filter((file) => file.path.startsWith(".codex/")).length ?? 0;
  const executionPhase = codexExecutionPhase(
    messages,
    workspaceSummary?.codexRuntimeStatus,
  );
  const executionEntryCount = importedHistory.filter(
    (entry) => entry.role === "reasoning" || entry.role === "command",
  ).length;
  const latestCodexTimelineItem = codexTimeline.at(-1);
  const hasRunningExecutionEntry =
    executionPhase === "running" &&
    latestCodexTimelineItem?.kind === "imported" &&
    latestCodexTimelineItem.item.kind === "execution";
  const canStopCodex = canMemberStopCodex(member, executionPhase);
  const primaryComposerAction = composerPrimaryAction(executionPhase, "codex");
  const primaryStopsCodex = primaryComposerAction === "stop_codex";
  const canSendChat = Boolean(
    !preparingChatAttachments && (chatDraft.trim() || pendingChatAttachments.length > 0),
  );
  const canSendCodex = Boolean(
    !preparingCodexAttachments && (draft.trim() || pendingAttachments.length > 0),
  );
  const selectedModelOption = getCodexModelOption(codexOptions.model);
  const selectedModelSupportsFast = codexModelSupportsFast(codexOptions.model);
  const selectedModelSupportsImages = codexModelSupportsImages(codexOptions.model);
  const availableReasoningEfforts = selectedModelOption
    ? reasoningEffortOrder.filter((effort) =>
        codexModelSupportsReasoningEffort(selectedModelOption.id, effort),
      )
    : reasoningEffortOrder;
  const customPermissions =
    codexOptions.customPermissions ?? DEFAULT_CODEX_CUSTOM_PERMISSIONS;

  return (
    <FluentProvider
      theme={themeMode === "dark" ? darkTheme : lightTheme}
      className="app-provider"
    >
      <div className="app-frame">
        <header className="topbar">
          <div className="brand-lockup">
            <div className="brand-mark" aria-hidden="true">
              <ChatMultipleRegular />
            </div>
            <div>
              <div className="product-context">共享 Codex 工作区</div>
              <h1>Codex Collab</h1>
            </div>
          </div>

          {member?.role === "owner" &&
          approved &&
          workspaceSummary?.hostConnected ? (
            <div className="topbar-thread-control">
              <HistoryRegular aria-hidden="true" />
              <div>
                <label htmlFor="topbar-codex-thread">聊天记录</label>
                <Select
                  id="topbar-codex-thread"
                  aria-label="聊天记录"
                  value={workspaceSummary.selectedThreadId ?? ""}
                  disabled={workspaceLoading || workspaceSummary.threads.length === 0}
                  onChange={(_, data) => void selectCodexThread(data.value)}
                >
                  <option value="">
                    {workspaceSummary.threads.length === 0
                      ? "暂无 Codex 记录"
                      : "请选择 Codex 任务"}
                  </option>
                  {workspaceSummary.threads.map((thread) => (
                    <option value={thread.id} key={thread.id}>
                      {thread.name || thread.preview || thread.id}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          ) : null}

          <div className="topbar-actions">
            {member?.role === "owner" && approved ? (
              <Switch
                className="room-switch"
                checked={roomOpen}
                disabled={roomStatusUpdating}
                label={roomOpen ? "房间已开启" : "房间已关闭"}
                aria-label={roomOpen ? "关闭房间" : "开启房间"}
                onChange={(_, data) => void updateRoomStatus(data.checked)}
              />
            ) : null}
            {approved ? (
              <Button
                appearance="secondary"
                icon={<FolderOpenRegular />}
                className="workspace-button"
                aria-label="Codex 与文件"
                onClick={() => void openWorkspace()}
              >
                <span className="workspace-button-label">Codex 与文件</span>
              </Button>
            ) : null}
            {member?.role === "owner" && approved ? (
              <Button
                appearance="secondary"
                icon={<PersonAddRegular />}
                className="invite-button"
                disabled={!roomOpen || roomStatusUpdating}
                onClick={createInvite}
              >
                创建邀请
              </Button>
            ) : null}
            <Button
              appearance="subtle"
              icon={<PersonAccountsRegular />}
              className="account-button"
              aria-label={accountProfile ? "打开我的房间" : "登录账号"}
              onClick={() => setAccountDialogOpen(true)}
            >
              <span className="account-button-label">
                {accountProfile?.account.displayName ?? "登录"}
              </span>
            </Button>
            <Button
              appearance="subtle"
              className="stable-icon-button"
              icon={
                themeMode === "dark" ? (
                  <WeatherSunnyRegular />
                ) : (
                  <WeatherMoonRegular />
                )
              }
              title="切换明暗主题"
              aria-label="切换明暗主题"
              onClick={() =>
                setThemeMode((current) =>
                  current === "dark" ? "light" : "dark",
                )
              }
            />
            {session ? (
              <Button
                appearance="subtle"
                icon={<SignOutRegular />}
                title="离开本机会话"
                aria-label="离开本机会话"
                onClick={resetSession}
              />
            ) : null}
            <Badge
              appearance="tint"
              aria-label={status.label}
              className="connection-badge"
              color={status.color}
              size="large"
            >
              {status.label}
            </Badge>
          </div>
        </header>

        {error ? (
          <div className="error-region" role="alert">
            <MessageBar intent="error">
              <MessageBarBody>
                <MessageBarTitle>需要处理</MessageBarTitle>
                {error}
              </MessageBarBody>
              <Button
                appearance="transparent"
                icon={<DismissRegular />}
                aria-label="关闭错误"
                onClick={() => setError(null)}
              />
            </MessageBar>
          </div>
        ) : null}

        <div className="workspace">
          <aside className="people-panel" aria-label="协作成员">
            <section className="member-section" aria-labelledby="member-section-title">
              <div className="panel-heading member-panel-heading">
                <div>
                  <h2 id="member-section-title">协作成员</h2>
                  <p>
                    {pendingMemberCount > 0
                      ? `${pendingMemberCount} 人等待批准`
                      : "身份与访问状态"}
                  </p>
                </div>
                <div className="member-heading-actions">
                  <span>{members.length} 人</span>
                  <Button
                    appearance="subtle"
                    className={`member-collapse-button ${
                      membersExpanded ? "expanded" : ""
                    }`}
                    icon={<ChevronDownRegular />}
                    aria-label={membersExpanded ? "折叠协作成员" : "展开协作成员"}
                    aria-expanded={membersExpanded}
                    aria-controls="collaboration-member-content"
                    onClick={() => setMembersExpanded((current) => !current)}
                  />
                </div>
              </div>

              {membersExpanded ? (
                <div className="member-section-body" id="collaboration-member-content">
                  <div className="member-list">
                    {loading && members.length === 0 ? (
                      <MemberSkeleton />
                    ) : members.length === 0 ? (
                      <div className="panel-empty">连接会话后显示成员</div>
                    ) : (
                      members.map((item) => {
                        const identity = identityForMember(item.id);
                        return (
                          <div className="member-row" key={item.id}>
                            <Avatar
                              name={item.displayName}
                              color={identity.avatarColor}
                            />
                            <div className="member-copy">
                              <strong>{item.displayName}</strong>
                              <span>{item.role === "owner" ? "主人" : "协作者"}</span>
                            </div>
                            {member?.role === "owner" && item.status === "pending" ? (
                              <Button
                                appearance="primary"
                                size="small"
                                onClick={() => approveMember(item)}
                              >
                                批准
                              </Button>
                            ) : (
                              <Badge
                                appearance="tint"
                                color={
                                  item.status === "approved" ? "success" : "warning"
                                }
                              >
                                {item.status === "approved" ? "已批准" : "等待中"}
                              </Badge>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>

                  <div className="handoff-rail">
                    <div className="handoff-icon" aria-hidden="true">
                      <LockClosedRegular />
                    </div>
                    <div>
                      <span>Codex 控制权</span>
                      <strong>
                        {owner ? `${owner.displayName} 的 Codex` : "等待绑定主人"}
                      </strong>
                      <p>协作者指令进入同一任务，关键操作仍由主人审批。</p>
                    </div>
                  </div>
                </div>
              ) : null}
            </section>

            <section className="peer-chat-panel" aria-labelledby="peer-chat-title">
              <div className="peer-chat-heading">
                <div>
                  <h2 id="peer-chat-title">协作聊天</h2>
                  <p>独立于 Codex 任务</p>
                </div>
                <Badge appearance="tint">{chatMessages.length}</Badge>
              </div>
              <div
                className="peer-chat-stream"
                ref={chatStreamRef}
                aria-label="成员聊天消息"
                aria-live="polite"
              >
                {chatMessages.length === 0 ? (
                  <div className="peer-chat-empty">
                    <ChatRegular aria-hidden="true" />
                    <p>
                      {approved ? "在这里和协作者单独沟通" : "批准后可查看协作聊天"}
                    </p>
                  </div>
                ) : (
                  chatMessages.map((item) => {
                    const mine = item.senderMemberId === member?.id;
                    const identity = identityForMember(item.senderMemberId);
                    return (
                      <article
                        className={`peer-chat-message ${mine ? "mine" : ""}`}
                        style={identity.style}
                        key={item.id}
                      >
                        <div className="peer-chat-meta">
                          <Avatar
                            name={item.senderDisplayName}
                            color={identity.avatarColor}
                            size={20}
                          />
                          <strong>{item.senderDisplayName}</strong>
                          <time dateTime={item.createdAt}>
                            {timeLabel(item.createdAt)}
                          </time>
                        </div>
                        <div className="peer-chat-bubble">
                          <p>{item.body}</p>
                          {item.attachments.length > 0 && session && token ? (
                            <div className="peer-chat-attachments">
                              {item.attachments.map((attachment) => (
                                <PeerChatAttachment
                                  sessionId={session.id}
                                  messageId={item.id}
                                  attachment={attachment}
                                  token={token}
                                  onError={showAttachmentError}
                                  key={attachment.id}
                                />
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </article>
                    );
                  })
                )}
              </div>
              <form
                className={`peer-chat-composer ${draggingChatFiles ? "dragging" : ""}`}
                onSubmit={(event) => {
                  event.preventDefault();
                  void sendMessage("chat");
                }}
                onDragEnter={(event) => {
                  event.preventDefault();
                  if (approved && roomOpen) setDraggingChatFiles(true);
                }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setDraggingChatFiles(false);
                  }
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  setDraggingChatFiles(false);
                  if (approved && roomOpen) {
                    void addChatAttachments(event.dataTransfer.files);
                  }
                }}
              >
                <input
                  ref={chatAttachmentInputRef}
                  className="visually-hidden"
                  type="file"
                  multiple
                  disabled={!approved || submitting || preparingChatAttachments || !roomOpen}
                  tabIndex={-1}
                  onChange={(event) => {
                    if (event.currentTarget.files) {
                      void addChatAttachments(event.currentTarget.files);
                    }
                    event.currentTarget.value = "";
                  }}
                />
                {preparingChatAttachments ? (
                  <div className="attachment-preparing" role="status">
                    <Spinner size="tiny" />
                    <span>正在压缩图片…</span>
                  </div>
                ) : null}
                {pendingChatAttachments.length > 0 ? (
                  <div
                    className="pending-attachments peer-chat-pending-attachments"
                    aria-label="待发送聊天附件"
                  >
                    {pendingChatAttachments.map((attachment) => (
                      <span key={attachment.id}>
                        <AttachRegular aria-hidden="true" />
                        <span title={attachment.file.name}>{attachment.file.name}</span>
                        <small>{attachmentSizeLabel(attachment)}</small>
                        <Button
                          type="button"
                          appearance="subtle"
                          size="small"
                          icon={<DeleteRegular />}
                          title={`移除 ${attachment.file.name}`}
                          aria-label={`移除 ${attachment.file.name}`}
                          onClick={() =>
                            setPendingChatAttachments((current) =>
                              current.filter((item) => item.id !== attachment.id),
                            )
                          }
                        />
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="peer-chat-composer-row">
                  <Button
                    type="button"
                    appearance="subtle"
                    icon={<AttachRegular />}
                    title="发送文件或图片"
                    aria-label="发送文件或图片"
                    disabled={!approved || submitting || preparingChatAttachments || !roomOpen}
                    onClick={() => chatAttachmentInputRef.current?.click()}
                  />
                  <Input
                    ref={chatInputRef}
                    value={chatDraft}
                    aria-label="输入协作聊天消息"
                    placeholder={
                      !roomOpen
                        ? "房间已关闭"
                        : approved
                          ? "给协作者发消息"
                          : "等待批准"
                    }
                    disabled={!approved || submitting || !roomOpen}
                    onChange={(_, data) => setChatDraft(data.value)}
                    onPaste={(event) => {
                      if (event.clipboardData.files.length > 0) {
                        event.preventDefault();
                        void addChatAttachments(event.clipboardData.files);
                      }
                    }}
                  />
                  <Button
                    type="submit"
                    appearance="primary"
                    icon={<SendRegular />}
                    aria-label="发送协作聊天消息"
                    disabled={!approved || submitting || !roomOpen || !canSendChat}
                  />
                </div>
              </form>
            </section>
          </aside>

          <main className="chat-panel">
            <div className="chat-heading">
              <div>
                <p className="session-id">
                  {session ? session.id : "尚未连接会话"}
                </p>
                <h2>{session?.name ?? "开始一个共享任务"}</h2>
              </div>
              {approved ? (
                <Button
                  appearance="subtle"
                  icon={<ArrowSyncRegular />}
                  title="刷新消息和成员"
                  aria-label="刷新消息和成员"
                  onClick={() => void refresh()}
                />
              ) : null}
            </div>

            <section
              className="message-stream"
              aria-label="Codex 对话"
              aria-busy={conversationLoading}
              ref={messageStreamRef}
              onScroll={(event) => {
                const stream = event.currentTarget;
                const pinned =
                  stream.scrollHeight - stream.scrollTop - stream.clientHeight < 96;
                messageStreamPinnedRef.current = pinned;
                setMessageStreamPinned(pinned);
              }}
            >
              {conversationLoading ? (
                <div className="conversation-loading" role="status" aria-live="polite">
                  <Spinner
                    label="正在加载对话记录"
                    labelPosition="below"
                    size="medium"
                  />
                </div>
              ) : !hasCodexContent ? (
                <div className="message-empty">
                  {member?.status === "pending" ? (
                    <>
                      <LockClosedRegular />
                      <h3>等待主人批准</h3>
                      <p>批准后，Codex 对话与执行记录会在这里实时同步。</p>
                    </>
                  ) : (
                    <>
                      <ChatMultipleRegular />
                      <h3>Codex 对话从这里开始</h3>
                      <p>成员聊天已独立放在左侧，这里只显示 Codex 任务。</p>
                    </>
                  )}
                </div>
              ) : (
                <>
                  {codexTimeline.map((timelineItem, timelineIndex) => {
                    if (timelineItem.kind === "shared") {
                      const item = timelineItem.message;
                      const mine = item.senderMemberId === member?.id;
                      const identity = identityForMember(item.senderMemberId);
                      return (
                        <article
                          className={`message identity-message ${mine ? "mine" : ""} ${
                            item.kind === "codex_prompt" || item.kind === "codex_stop"
                              ? "codex-message"
                              : ""
                          }`}
                          style={identity.style}
                          key={`shared-${item.id}`}
                        >
                          <div className="message-meta">
                            <span>{item.senderDisplayName}</span>
                            <span>
                              {item.kind === "codex_prompt"
                                ? "Codex 指令"
                                : item.kind === "codex_stop"
                                  ? "停止指令"
                                  : "聊天"}
                            </span>
                            {deliveryStatusLabel(item) ? (
                              <span
                                className={`delivery-status ${
                                  item.deliveryStatus ?? "queued"
                                }`}
                              >
                                {deliveryStatusLabel(item)}
                              </span>
                            ) : null}
                            <time dateTime={item.createdAt}>
                              {timeLabel(item.createdAt)}
                            </time>
                          </div>
                          <div className="message-bubble">
                            {item.kind === "codex_prompt" || item.kind === "codex_stop" ? (
                              <BotRegular aria-hidden="true" />
                            ) : null}
                            <div className="message-content">
                              <p>{item.body}</p>
                              {item.attachments.length > 0 ? (
                                <div className="message-attachments">
                                  {item.attachments.map((attachment) => (
                                    <span key={attachment.id}>
                                      <AttachRegular aria-hidden="true" />
                                      <span>{attachment.name}</span>
                                      <small>{formatFileSize(attachment.size)}</small>
                                    </span>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                          </div>
                        </article>
                      );
                    }

                    const item = timelineItem.item;
                    if (item.kind === "message") {
                      const entry = item.entry;
                      const importedMine =
                        entry.role === "user" &&
                        session?.ownerMemberId === member?.id;
                      const importedIdentity =
                        entry.role === "user" && session
                          ? identityForMember(session.ownerMemberId)
                          : null;
                      return (
                        <article
                          className={`message imported-message ${entry.role} ${
                            importedMine ? "mine" : ""
                          } ${
                            importedIdentity ? "identity-message" : ""
                          }`}
                          style={importedIdentity?.style}
                          key={`codex-${entry.id}`}
                        >
                          <div className="message-meta">
                            <span>{recordRoleLabel(entry.role)}</span>
                            {entry.createdAt ? (
                              <time dateTime={entry.createdAt}>
                                {timeLabel(entry.createdAt)}
                              </time>
                            ) : null}
                          </div>
                          <div className="message-bubble">
                            {entry.role === "assistant" ? (
                              <BotRegular aria-hidden="true" />
                            ) : null}
                            <div className="message-content">
                              {entry.role === "assistant" ? (
                                <ReadableOutput text={entry.text} />
                              ) : (
                                <p>{entry.text}</p>
                              )}
                            </div>
                          </div>
                        </article>
                      );
                    }

                    return (
                      <ExecutionProcess
                        active={
                          executionPhase === "running" &&
                          timelineIndex === codexTimeline.length - 1
                        }
                        entries={item.entries}
                        key={item.id}
                      />
                    );
                  })}
                </>
              )}
              {!messageStreamPinned && hasCodexContent ? (
                <Button
                  className="jump-to-latest"
                  icon={<ChevronDownRegular />}
                  onClick={() => {
                    const stream = messageStreamRef.current;
                    if (!stream) return;
                    stream.scrollTop = stream.scrollHeight;
                    messageStreamPinnedRef.current = true;
                    setMessageStreamPinned(true);
                  }}
                  size="small"
                >
                  跳到最新
                </Button>
              ) : null}
              {!conversationLoading &&
              shouldShowExecutionStatus(executionPhase, hasRunningExecutionEntry) ? (
                <div
                  className={`codex-execution-status ${executionPhase}`}
                  role="status"
                  aria-live="polite"
                >
                  <Spinner size="tiny" />
                  <div>
                    <strong>
                      {executionPhase === "queued"
                        ? "Codex 指令已排队"
                        : executionPhase === "stopping"
                          ? "正在停止 Codex"
                          : "正在运行"}
                    </strong>
                    <span>
                      {executionPhase === "queued"
                        ? "等待共享任务开始执行"
                        : executionPhase === "stopping"
                          ? "停止请求已发送，请稍候"
                          : executionEntryCount > 0
                            ? `已显示 ${executionEntryCount} 条过程记录，正在等待下一步`
                            : "首个执行步骤到达后会显示在这里"}
                    </span>
                  </div>
                </div>
              ) : null}
            </section>

            <form
              className={`composer ${draggingFiles ? "dragging" : ""}`}
              onSubmit={(event) => {
                event.preventDefault();
                if (primaryStopsCodex) {
                  if (canStopCodex) void sendMessage("codex_stop");
                  return;
                }
                void sendMessage("codex_prompt");
              }}
              onDragEnter={(event) => {
                event.preventDefault();
                if (approved) setDraggingFiles(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setDraggingFiles(false);
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                setDraggingFiles(false);
                if (approved) void addAttachments(event.dataTransfer.files);
              }}
            >
              <input
                ref={attachmentInputRef}
                className="visually-hidden"
                type="file"
                multiple
                disabled={!roomOpen || preparingCodexAttachments}
                tabIndex={-1}
                onChange={(event) => {
                  if (event.currentTarget.files) {
                    void addAttachments(event.currentTarget.files);
                  }
                  event.currentTarget.value = "";
                }}
              />
              <div className="composer-surface">
                <Textarea
                  ref={codexTextareaRef}
                  value={draft}
                  resize="none"
                  disabled={!approved || submitting || !roomOpen}
                  aria-label="发送给 Codex"
                  placeholder={
                    !roomOpen
                      ? "房间已关闭"
                      : approved
                        ? "随心输入"
                        : "连接并通过批准后即可发送"
                  }
                  onChange={(_, data) => setDraft(data.value)}
                  onPaste={(event) => {
                    if (event.clipboardData.files.length > 0) {
                      event.preventDefault();
                      void addAttachments(event.clipboardData.files);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      if (primaryStopsCodex) {
                        if (canStopCodex) void sendMessage("codex_stop");
                      } else if (canSendCodex) {
                        void sendMessage("codex_prompt");
                      }
                    }
                  }}
                />
                {preparingCodexAttachments ? (
                  <div className="attachment-preparing" role="status">
                    <Spinner size="tiny" />
                    <span>正在压缩图片…</span>
                  </div>
                ) : null}
                {pendingAttachments.length > 0 ? (
                  <div className="pending-attachments" aria-label="待发送附件">
                    {pendingAttachments.map((attachment) => (
                      <span key={attachment.id}>
                        <AttachRegular aria-hidden="true" />
                        <span title={attachment.file.name}>{attachment.file.name}</span>
                        <small>{attachmentSizeLabel(attachment)}</small>
                        <Button
                          type="button"
                          appearance="subtle"
                          size="small"
                          icon={<DeleteRegular />}
                          title={`移除 ${attachment.file.name}`}
                          aria-label={`移除 ${attachment.file.name}`}
                          onClick={() =>
                            setPendingAttachments((current) =>
                              current.filter((item) => item.id !== attachment.id),
                            )
                          }
                        />
                      </span>
                    ))}
                  </div>
                ) : null}
                {selectedModelOption &&
                (!selectedModelSupportsFast || !selectedModelSupportsImages) ? (
                  <div className="composer-capability-note" role="status">
                    <strong>{selectedModelOption.label}</strong>
                    <span>
                      {!selectedModelSupportsImages
                        ? "仅支持文本输入，图片会被拦截"
                        : "不支持快速模式，发送时使用标准速度"}
                    </span>
                  </div>
                ) : null}

                <div className="composer-toolbar">
                  <div className="composer-tools">
                    <Button
                      type="button"
                      appearance="subtle"
                      className="stable-icon-button"
                      icon={<AttachRegular />}
                      title={
                        selectedModelSupportsImages
                          ? "添加文件或图片"
                          : "添加文本文件（当前模型不支持图片）"
                      }
                      aria-label={
                        selectedModelSupportsImages
                          ? "添加文件或图片"
                          : "添加文本文件（当前模型不支持图片）"
                      }
                      disabled={
                        !approved ||
                        submitting ||
                        preparingCodexAttachments ||
                        !roomOpen
                      }
                      onClick={() => attachmentInputRef.current?.click()}
                    />
                    <Button
                      type="button"
                      appearance={dictating ? "primary" : "subtle"}
                      className="stable-icon-button"
                      icon={dictating ? <StopRegular /> : <MicRegular />}
                      title={dictating ? "停止听写" : "听写"}
                      aria-label={dictating ? "停止听写" : "听写"}
                      disabled={!approved || submitting || !roomOpen}
                      onClick={toggleDictation}
                    />
                    <Select
                      aria-label="Codex 权限"
                      title="Codex 权限"
                      value={codexOptions.accessMode}
                      disabled={
                        !approved ||
                        submitting ||
                        !roomOpen ||
                        member?.role !== "owner"
                      }
                      onChange={(_, data) => {
                        const accessMode = data.value as CodexAccessMode;
                        setCodexOptions((current) =>
                          normalizeCodexOptionsForUi({
                            ...current,
                            accessMode,
                            customPermissions:
                              accessMode === "custom"
                                ? current.customPermissions ?? {
                                    ...DEFAULT_CODEX_CUSTOM_PERMISSIONS,
                                  }
                                : null,
                          }),
                        );
                      }}
                    >
                      <option value="follow-desktop">跟随当前任务权限</option>
                      <option value="request-approval">请求批准</option>
                      <option value="auto">替我审批</option>
                      <option value="full-access">完全访问</option>
                      <option value="custom">自定义权限</option>
                    </Select>
                    <Select
                      aria-label="Codex 模型"
                      title="Codex 模型"
                      value={codexOptions.model ?? ""}
                      disabled={
                        !approved ||
                        submitting ||
                        !roomOpen
                      }
                      onChange={(_, data) => {
                        const model = (data.value || null) as CodexModelId | null;
                        setCodexOptions((current) =>
                          normalizeCodexOptionsForUi({ ...current, model }),
                        );
                        const retainedAttachments = filterUnsupportedImageAttachments(
                          model,
                          pendingAttachments,
                        );
                        if (retainedAttachments.length !== pendingAttachments.length) {
                          setPendingAttachments(retainedAttachments);
                          const modelLabel = getCodexModelOption(model)?.label ?? "当前模型";
                          setError(`${modelLabel} 仅支持文本，已移除待发送的图片`);
                        }
                      }}
                    >
                      <option value="">跟随当前任务模型</option>
                      {CODEX_MODEL_OPTIONS.map((option) => (
                        <option value={option.id} key={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </Select>
                    <Select
                      aria-label="推理强度"
                      title="推理强度"
                      value={codexOptions.reasoningEffort}
                      disabled={
                        !approved ||
                        submitting ||
                        !roomOpen
                      }
                      onChange={(_, data) => {
                        const reasoningEffort = data.value as CodexReasoningEffort;
                        setCodexOptions((current) => ({
                          ...current,
                          reasoningEffort,
                        }));
                      }}
                    >
                      <option value="follow-desktop">跟随推理强度</option>
                      {availableReasoningEfforts.map((effort) => (
                        <option value={effort} key={effort}>
                          {reasoningEffortLabels[effort]}
                        </option>
                      ))}
                    </Select>
                    <Select
                      aria-label="响应速度"
                      title={
                        selectedModelSupportsFast
                          ? "响应速度"
                          : `${selectedModelOption?.label ?? "当前模型"} 不支持快速模式`
                      }
                      value={codexOptions.speed}
                      disabled={
                        !approved ||
                        submitting ||
                        !roomOpen
                      }
                      onChange={(_, data) => {
                        const speed = data.value as CodexSpeed;
                        setCodexOptions((current) => ({
                          ...current,
                          speed,
                        }));
                      }}
                    >
                      <option value="follow-desktop">跟随速度</option>
                      <option value="standard">标准</option>
                      <option value="fast" disabled={!selectedModelSupportsFast}>
                        快速
                      </option>
                    </Select>
                    <Checkbox
                      label="计划模式"
                      checked={codexOptions.planMode}
                      disabled={
                        !approved ||
                        submitting ||
                        !roomOpen
                      }
                      onChange={(_, data) =>
                        setCodexOptions((current) => ({
                          ...current,
                          planMode: data.checked === true,
                        }))
                      }
                    />
                  </div>
                  <div className="composer-actions">
                    <Button
                      type="submit"
                      appearance="primary"
                      shape="circular"
                      icon={primaryStopsCodex ? <StopRegular /> : <SendRegular />}
                      title={
                        primaryStopsCodex
                          ? executionPhase === "stopping"
                            ? "正在停止 Codex"
                            : "停止 Codex"
                          : "发送给 Codex"
                      }
                      aria-label={
                        primaryStopsCodex
                          ? executionPhase === "stopping"
                            ? "正在停止 Codex"
                            : "停止 Codex"
                          : "发送给 Codex"
                      }
                      disabled={
                        !approved ||
                        submitting ||
                        (primaryStopsCodex
                          ? !canStopCodex
                          : !roomOpen || !canSendCodex)
                      }
                    />
                  </div>
                </div>
                {codexOptions.accessMode === "custom" ? (
                  <div className="custom-permission-panel" aria-label="自定义 Codex 权限">
                    <Field label="文件访问">
                      <Select
                        size="small"
                        aria-label="自定义文件访问"
                        value={customPermissions.fileAccess}
                        disabled={
                          !approved ||
                          submitting ||
                          !roomOpen ||
                          member?.role !== "owner"
                        }
                        onChange={(_, data) => {
                          const fileAccess = data.value as CodexCustomFileAccess;
                          setCodexOptions((current) => ({
                            ...current,
                            customPermissions: {
                              ...(current.customPermissions ??
                                DEFAULT_CODEX_CUSTOM_PERMISSIONS),
                              fileAccess,
                            },
                          }));
                        }}
                      >
                        <option value="read-only">默认只读</option>
                        <option value="workspace-write">工作区可写</option>
                        <option value="full-access">完全访问</option>
                      </Select>
                    </Field>
                    <Field label="批准方式">
                      <Select
                        size="small"
                        aria-label="自定义批准方式"
                        value={customPermissions.approvalPolicy}
                        disabled={
                          !approved ||
                          submitting ||
                          !roomOpen ||
                          member?.role !== "owner"
                        }
                        onChange={(_, data) => {
                          const approvalPolicy =
                            data.value as CodexCustomApprovalPolicy;
                          setCodexOptions((current) => ({
                            ...current,
                            customPermissions: {
                              ...(current.customPermissions ??
                                DEFAULT_CODEX_CUSTOM_PERMISSIONS),
                              approvalPolicy,
                            },
                          }));
                        }}
                      >
                        <option value="on-request">需要时请求批准</option>
                        <option value="never">不再请求批准</option>
                      </Select>
                    </Field>
                    <p>
                      {customPermissions.approvalPolicy === "on-request"
                        ? "默认按所选文件范围执行，需要越权时仍会请求房主批准。"
                        : "按所选文件范围自动执行，不会请求额外批准。"}
                    </p>
                  </div>
                ) : null}
              </div>
            </form>
          </main>

          <aside className="activity-panel" aria-label="任务活动">
            <div className="panel-heading">
              <div>
                <h2>任务活动</h2>
                <p>最近的协作事件</p>
              </div>
              <span>实时</span>
            </div>
            <div className="activity-list">
              {activities.map((item) => (
                <div className={`activity-item ${item.tone}`} key={item.id}>
                  <div className="activity-line" aria-hidden="true">
                    <span />
                  </div>
                  <div>
                    <strong>{item.title}</strong>
                    <p>{item.detail}</p>
                    <time dateTime={item.createdAt}>
                      {timeLabel(item.createdAt)}
                    </time>
                  </div>
                </div>
              ))}
            </div>
          </aside>
        </div>
      </div>

      <Dialog
        open={workspaceOpen}
        onOpenChange={(_, data) => setWorkspaceOpen(data.open)}
      >
        <DialogSurface className="workspace-dialog-surface">
          <DialogBody>
            <DialogTitle>Codex 任务与共享文件</DialogTitle>
            <DialogContent className="workspace-dialog-content">
              <p className="dialog-intro">
                房主选择本机 Codex 任务后，导入可见消息、推理摘要、命令输出、项目文本，
                以及单独授权的 .codex 非凭据配置。已批准成员拥有只读访问权。
              </p>

              {workspaceLoading && !workspaceSummary ? (
                <div className="workspace-dialog-loading">
                  <Skeleton>
                    <SkeletonItem />
                    <SkeletonItem />
                  </Skeleton>
                </div>
              ) : null}

              {!workspaceSummary?.hostConnected ? (
                <section className="pairing-panel">
                  <div className="workspace-section-heading">
                    <div>
                      <span>步骤 1</span>
                      <h3>连接房主的本机 Codex</h3>
                    </div>
                    {member?.role === "owner" ? (
                      <Button
                        appearance="primary"
                        disabled={workspaceLoading}
                        onClick={() => void createHostPairing()}
                      >
                        生成一次性配对码
                      </Button>
                    ) : null}
                  </div>
                  {member?.role !== "owner" ? (
                    <MessageBar intent="info">
                      <MessageBarBody>等待房主连接本机 Codex 工作区。</MessageBarBody>
                    </MessageBar>
                  ) : null}
                  {pairingToken ? (
                    <div className="pairing-instructions">
                      <Field label="一次性配对码">
                        <Input
                          ref={pairingTokenRef}
                          value={pairingToken}
                          readOnly
                          onClick={(event) => event.currentTarget.select()}
                          onFocus={(event) => event.currentTarget.select()}
                          contentAfter={
                            <Button
                              appearance="transparent"
                              icon={<CopyRegular />}
                              aria-label="复制配对码"
                              onClick={() => void copyPairingToken()}
                            />
                          }
                        />
                      </Field>
                      <p>
                        回到房主的 Codex 对话，让 Codex 使用
                        <strong> collab_pair_host </strong>
                        认领此码，明确传入 projectRoot；如需配置文件，再单独传入
                        codexConfigRoot（例如用户目录下的 .codex 绝对路径）。
                      </p>
                      <span>
                        {pairingCopied ? "配对码已复制 · " : ""}
                        有效至 {new Date(pairingExpiresAt).toLocaleTimeString("zh-CN")}
                      </span>
                    </div>
                  ) : null}
                </section>
              ) : (
                <>
                  <section className="workspace-status-card">
                    <div>
                      <span>本机已连接</span>
                      <strong>{workspaceSummary.rootLabel}</strong>
                      <small>{workspaceSummary.hostDeviceLabel}</small>
                    </div>
                    <Badge appearance="tint" color="success">
                      {workspaceSummary.syncedAt ? "已同步" : "等待导入"}
                    </Badge>
                  </section>

                  <section className="thread-picker">
                    <div className="workspace-section-heading">
                      <div>
                        <span>当前记录</span>
                        <h3>已共享的 Codex 任务</h3>
                      </div>
                      {workspaceSummary.syncedAt ? (
                        <small>
                          最近同步 {timeLabel(workspaceSummary.syncedAt)}
                        </small>
                      ) : null}
                    </div>
                    {workspaceSummary.selectedThread ? (
                      <div className="selected-thread-summary">
                        <HistoryRegular />
                        <div>
                          <strong>
                            {workspaceSummary.selectedThread.name ||
                              workspaceSummary.selectedThread.preview ||
                              "已共享 Codex 任务"}
                          </strong>
                          <span>{workspaceSummary.selectedThread.preview}</span>
                        </div>
                      </div>
                    ) : (
                      <MessageBar intent="info">
                        <MessageBarBody>
                          {member?.role === "owner"
                            ? "请在页面顶部选择要共享的聊天记录。"
                            : "等待房主选择要共享的 Codex 任务。"}
                        </MessageBarBody>
                      </MessageBar>
                    )}
                    {workspaceSummary.selectedThreadId && !workspaceSummary.syncedAt ? (
                      <MessageBar intent="info">
                        <MessageBarBody>
                          任务已选择，正在等待房主本机插件导入。请保持 Codex 运行。
                        </MessageBarBody>
                      </MessageBar>
                    ) : null}
                  </section>

                  <div className="workspace-data-grid">
                    <section className="history-panel">
                      <div className="workspace-section-heading compact">
                        <div>
                          <span>导入记录</span>
                          <h3>Codex 对话</h3>
                        </div>
                        <small>{workspaceSummary.history.length} 条</small>
                      </div>
                      <div className="record-list">
                        {workspaceSummary.history.length === 0 ? (
                          <div className="workspace-empty">选择任务并完成同步后显示记录</div>
                        ) : (
                          workspaceSummary.history.map((entry) =>
                            entry.role === "command" ? (
                              <ExecutionStepCard
                                compact
                                key={entry.id}
                                record={presentExecutionEntry(entry)}
                              />
                            ) : (
                              <article className={`record-entry ${entry.role}`} key={entry.id}>
                                <div>
                                  <strong>{recordRoleLabel(entry.role)}</strong>
                                  {entry.createdAt ? (
                                    <time dateTime={entry.createdAt}>
                                      {timeLabel(entry.createdAt)}
                                    </time>
                                  ) : null}
                                </div>
                                {entry.role === "assistant" || entry.role === "reasoning" ? (
                                  <ReadableOutput text={entry.text} />
                                ) : (
                                  <p>{entry.text}</p>
                                )}
                              </article>
                            ),
                          )
                        )}
                      </div>
                    </section>

                    <section className="files-panel">
                      <div className="workspace-section-heading compact">
                        <div>
                          <span>只读快照</span>
                          <h3>项目文件</h3>
                        </div>
                        <small>
                          {workspaceSummary.files.length} 个
                          {codexConfigFileCount > 0
                            ? ` · .codex 配置 ${codexConfigFileCount} 个`
                            : ""}
                        </small>
                      </div>
                      <div className="file-browser">
                        <nav aria-label="共享文件">
                          {workspaceSummary.files.length === 0 ? (
                            <div className="workspace-empty">同步后显示可安全共享的文本文件</div>
                          ) : (
                            workspaceSummary.files.map((file) => (
                              <button
                                type="button"
                                className={selectedFile?.path === file.path ? "active" : ""}
                                key={file.path}
                                onClick={() => void openWorkspaceFile(file.path)}
                              >
                                <DocumentRegular />
                                <span>{file.path}</span>
                                <small>{Math.max(1, Math.ceil(file.size / 1024))} KB</small>
                              </button>
                            ))
                          )}
                        </nav>
                        <div className="file-preview">
                          {fileLoading ? (
                            <span>正在读取文件…</span>
                          ) : selectedFile ? (
                            <>
                              <header>
                                <strong>{selectedFile.path}</strong>
                                <span>SHA {selectedFile.sha256.slice(0, 10)}</span>
                              </header>
                              <pre>{selectedFile.content}</pre>
                            </>
                          ) : (
                            <div className="workspace-empty">选择文件查看内容</div>
                          )}
                        </div>
                      </div>
                    </section>
                  </div>
                </>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setWorkspaceOpen(false)}>
                关闭
              </Button>
              {workspaceSummary?.hostConnected ? (
                <Button
                  appearance="primary"
                  icon={<ArrowSyncRegular />}
                  disabled={workspaceLoading}
                  onClick={() => void openWorkspace()}
                >
                  刷新
                </Button>
              ) : null}
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog open={setupOpen}>
        <DialogSurface>
          <form onSubmit={submitSetup}>
            <DialogBody>
              <DialogTitle>
                {accountProfile ? "选择或创建房间" : "登录 Codex Collab"}
              </DialogTitle>
              <DialogContent className="setup-fields">
                {credentialNotice ? (
                  <MessageBar intent="warning">
                    <MessageBarBody>
                      <MessageBarTitle>需要重新连接</MessageBarTitle>
                      {credentialNotice}
                    </MessageBarBody>
                    <Button
                      appearance="transparent"
                      icon={<DismissRegular />}
                      aria-label="关闭会话失效提示"
                      onClick={() => setCredentialNotice(null)}
                    />
                  </MessageBar>
                ) : null}
                {accountError ? (
                  <MessageBar intent="error">
                    <MessageBarBody>
                      <MessageBarTitle>账号操作未完成</MessageBarTitle>
                      {accountError}
                    </MessageBarBody>
                  </MessageBar>
                ) : null}
                {accountChecking ? (
                  <div className="account-loading" aria-live="polite">
                    <Spinner size="small" label="正在检查账号状态" />
                  </div>
                ) : !accountProfile ? (
                  <>
                    <p className="dialog-intro">
                      使用设备通行密钥保存你的房间。以后在其他支持的设备上登录即可继续使用。
                    </p>
                    {!supportsPasskeys ? (
                      <MessageBar intent="warning">
                        <MessageBarBody>
                          通行密钥需要 HTTPS，或从本机 localhost 地址打开。
                        </MessageBarBody>
                      </MessageBar>
                    ) : null}
                    {initialInviteToken ? (
                      <MessageBar intent="success">
                        <MessageBarBody>
                          邀请已经读取。登录或创建账号后继续申请加入。
                        </MessageBarBody>
                      </MessageBar>
                    ) : null}
                    <Field label="新账号显示名称" required>
                      <Input
                        value={accountDisplayName}
                        maxLength={80}
                        autoComplete="name webauthn"
                        onChange={(_, data) => setAccountDisplayName(data.value)}
                      />
                    </Field>
                  </>
                ) : (
                  <>
                    <div className="account-summary">
                      <Avatar
                        name={accountProfile.account.displayName}
                        color="colorful"
                        size={36}
                      />
                      <div>
                        <strong>{accountProfile.account.displayName}</strong>
                        <span>{accountProfile.rooms.length} 个已保存房间</span>
                      </div>
                    </div>
                    {!initialInviteToken && accountProfile.rooms.length > 0 ? (
                      <AccountRoomList
                        rooms={accountProfile.rooms}
                        currentSessionId={session?.id ?? null}
                        restoringRoomId={restoringRoomId}
                        onRestore={(room) => void activateAccountRoom(room)}
                      />
                    ) : null}
                    {!initialInviteToken && accountProfile.rooms.length > 0 ? (
                      <div className="dialog-divider">
                        <span>创建或加入其他房间</span>
                      </div>
                    ) : null}
                    <p className="dialog-intro">
                      {initialInviteToken
                        ? "你收到了一次性协作邀请。申请后仍需主人明确批准。"
                        : "创建一个新房间，或使用一次性邀请令牌加入。"}
                    </p>
                    <Field label="房间内显示名称" required>
                      <Input
                        value={displayName}
                        maxLength={80}
                        autoComplete="name"
                        onChange={(_, data) => setDisplayName(data.value)}
                      />
                    </Field>
                    {initialInviteToken ? (
                      <MessageBar intent="success">
                        <MessageBarBody>
                          一次性邀请已读取。提交后需要等待主人明确批准。
                        </MessageBarBody>
                      </MessageBar>
                    ) : (
                      <>
                    <Field label="新会话名称">
                      <Input
                        value={roomName}
                        maxLength={120}
                        onChange={(_, data) => setRoomName(data.value)}
                      />
                    </Field>
                    <div className="dialog-divider">
                      <span>或者</span>
                    </div>
                    <Field label="邀请令牌">
                      <Input
                        value={joinToken}
                        contentBefore={<KeyRegular />}
                        placeholder="cci_..."
                        onChange={(_, data) => setJoinToken(data.value)}
                      />
                    </Field>
                      </>
                    )}
                  </>
                )}
              </DialogContent>
              <DialogActions>
                {accountChecking ? null : !accountProfile ? (
                  <>
                    <Button
                      type="button"
                      appearance="secondary"
                      disabled={!supportsPasskeys || accountSubmitting}
                      onClick={() => void authenticateAccount("signin")}
                    >
                      使用通行密钥登录
                    </Button>
                    <Button
                      type="button"
                      appearance="primary"
                      disabled={
                        !supportsPasskeys || !accountDisplayName.trim() || accountSubmitting
                      }
                      onClick={() => void authenticateAccount("register")}
                    >
                      创建账号
                    </Button>
                  </>
                ) : joinToken.trim() ? (
                  <Button
                    type="submit"
                    appearance="primary"
                    disabled={!displayName.trim() || submitting}
                  >
                    申请加入
                  </Button>
                ) : (
                  <Button
                    type="submit"
                    appearance="primary"
                    disabled={!displayName.trim() || !roomName.trim() || submitting}
                  >
                    创建会话
                  </Button>
                )}
              </DialogActions>
            </DialogBody>
          </form>
        </DialogSurface>
      </Dialog>

      <Dialog
        open={accountDialogOpen}
        onOpenChange={(_, data) => setAccountDialogOpen(data.open)}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{accountProfile ? "我的房间" : "账号登录"}</DialogTitle>
            <DialogContent className="setup-fields">
              {accountError ? (
                <MessageBar intent="error">
                  <MessageBarBody>
                    <MessageBarTitle>账号操作未完成</MessageBarTitle>
                    {accountError}
                  </MessageBarBody>
                </MessageBar>
              ) : null}
              {accountProfile ? (
                <>
                  <div className="account-summary">
                    <Avatar
                      name={accountProfile.account.displayName}
                      color="colorful"
                      size={40}
                    />
                    <div>
                      <strong>{accountProfile.account.displayName}</strong>
                      <span>通行密钥账号</span>
                    </div>
                  </div>
                  {accountProfile.rooms.length > 0 ? (
                    <AccountRoomList
                      rooms={accountProfile.rooms}
                      currentSessionId={session?.id ?? null}
                      restoringRoomId={restoringRoomId}
                      onRestore={(room) => void activateAccountRoom(room)}
                    />
                  ) : (
                    <div className="account-empty">
                      创建房间或通过邀请加入后，这里会保存你的房间。
                    </div>
                  )}
                </>
              ) : (
                <>
                  <p className="dialog-intro">
                    登录后可以从其他支持通行密钥的设备重新进入自己的房间。
                  </p>
                  {!supportsPasskeys ? (
                    <MessageBar intent="warning">
                      <MessageBarBody>
                        通行密钥需要 HTTPS，或从本机 localhost 地址打开。
                      </MessageBarBody>
                    </MessageBar>
                  ) : null}
                  <Field label="新账号显示名称" required>
                    <Input
                      value={accountDisplayName}
                      maxLength={80}
                      autoComplete="name webauthn"
                      onChange={(_, data) => setAccountDisplayName(data.value)}
                    />
                  </Field>
                </>
              )}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setAccountDialogOpen(false)}>
                关闭
              </Button>
              {accountProfile ? (
                <Button
                  appearance="secondary"
                  icon={<SignOutRegular />}
                  disabled={accountSubmitting}
                  onClick={() => void signOutAccount()}
                >
                  退出账号
                </Button>
              ) : (
                <>
                  <Button
                    appearance="secondary"
                    disabled={!supportsPasskeys || accountSubmitting}
                    onClick={() => void authenticateAccount("signin")}
                  >
                    使用通行密钥登录
                  </Button>
                  <Button
                    appearance="primary"
                    disabled={
                      !supportsPasskeys || !accountDisplayName.trim() || accountSubmitting
                    }
                    onClick={() => void authenticateAccount("register")}
                  >
                    创建账号
                  </Button>
                </>
              )}
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>

      <Dialog open={inviteOpen} onOpenChange={(_, data) => setInviteOpen(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>邀请一位协作者</DialogTitle>
            <DialogContent className="setup-fields">
              <p className="dialog-intro">
                链接有效期 60 分钟，仅可使用一次。对方申请加入后仍需你的批准。
              </p>
              {isLoopbackOrigin() ? (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    当前链接仅能在这台电脑打开。邀请其他设备前，请从局域网地址或已部署的
                    HTTPS Relay 打开控制台。
                  </MessageBarBody>
                </MessageBar>
              ) : null}
              <Field label="一次性邀请链接">
                <Input
                  ref={inviteLinkRef}
                  value={inviteLink}
                  readOnly
                  onClick={(event) => event.currentTarget.select()}
                  onFocus={(event) => event.currentTarget.select()}
                />
              </Field>
              {copied ? (
                <div className="copy-confirmation" aria-live="polite">
                  <CheckmarkCircleRegular />
                  邀请链接已复制
                </div>
              ) : null}
              {copyFailed ? (
                <MessageBar intent="warning">
                  <MessageBarBody>
                    <MessageBarTitle>浏览器阻止了自动复制</MessageBarTitle>
                    链接已经选中，请按 Ctrl+C 复制。
                  </MessageBarBody>
                </MessageBar>
              ) : null}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setInviteOpen(false)}>
                关闭
              </Button>
              <Button
                appearance="primary"
                icon={<CopyRegular />}
                onClick={() => void copyInvite()}
              >
                {copied ? "已复制" : "复制邀请链接"}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </FluentProvider>
  );
}

function AccountRoomList({
  rooms,
  currentSessionId,
  restoringRoomId,
  onRestore,
}: {
  rooms: AccountRoom[];
  currentSessionId: string | null;
  restoringRoomId: string | null;
  onRestore: (room: AccountRoom) => void;
}) {
  return (
    <div className="account-room-list" role="list" aria-label="我的房间">
      {rooms.map((room) => {
        const current = room.session.id === currentSessionId;
        const inactive =
          room.member.status === "rejected" || room.member.status === "revoked";
        const statusLabel =
          room.member.status === "pending"
            ? "等待批准"
            : room.member.status === "rejected"
              ? "已拒绝"
              : room.member.status === "revoked"
                ? "权限已撤销"
                : room.member.role === "owner"
                  ? "主人"
                  : "成员";
        const statusColor =
          room.member.status === "pending"
            ? "warning"
            : inactive
              ? "danger"
              : "success";
        return (
          <div className="account-room-item" role="listitem" key={room.session.id}>
            <div className="account-room-icon" aria-hidden="true">
              <HomeRegular />
            </div>
            <div className="account-room-copy">
              <strong>{room.session.name}</strong>
              <span>
                {room.session.roomStatus === "closed" ? "房间已关闭" : statusLabel}
                {room.lastUsedAt
                  ? `，上次使用 ${new Intl.DateTimeFormat("zh-CN", {
                      month: "numeric",
                      day: "numeric",
                    }).format(new Date(room.lastUsedAt))}`
                  : ""}
              </span>
            </div>
            <Badge appearance="tint" color={statusColor}>
              {statusLabel}
            </Badge>
            <Button
              appearance={current ? "secondary" : "primary"}
              size="small"
              aria-current={current ? "page" : undefined}
              disabled={current || inactive || restoringRoomId !== null}
              onClick={() => onRestore(room)}
            >
              {current
                ? "当前房间"
                : restoringRoomId === room.session.id
                  ? "正在进入"
                  : "进入"}
            </Button>
          </div>
        );
      })}
    </div>
  );
}

function connectionPresentation(
  state: ConnectionState,
  hasSession: boolean,
): { label: string; color: "success" | "warning" | "danger" | "informative" } {
  if (!hasSession) {
    return { label: "Relay 就绪", color: "informative" };
  }
  if (state === "live") {
    return { label: "实时连接", color: "success" };
  }
  if (state === "waiting") {
    return { label: "等待批准", color: "warning" };
  }
  if (state === "error") {
    return { label: "需要处理", color: "danger" };
  }
  return { label: "正在连接", color: "informative" };
}

function MemberSkeleton() {
  return (
    <Skeleton aria-label="正在加载成员">
      <div className="member-skeleton">
        <SkeletonItem shape="circle" size={32} />
        <div>
          <SkeletonItem size={12} />
          <SkeletonItem size={8} />
        </div>
      </div>
      <div className="member-skeleton">
        <SkeletonItem shape="circle" size={32} />
        <div>
          <SkeletonItem size={12} />
          <SkeletonItem size={8} />
        </div>
      </div>
    </Skeleton>
  );
}
