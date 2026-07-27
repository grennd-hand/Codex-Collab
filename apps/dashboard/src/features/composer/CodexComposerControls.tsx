import { Button, Checkbox, Field, Select } from "@fluentui/react-components";
import {
  AttachRegular,
  MicRegular,
  SendRegular,
  StopRegular,
} from "@fluentui/react-icons";
import type {
  CodexAccessMode,
  CodexCustomApprovalPolicy,
  CodexCustomFileAccess,
  CodexModelId,
  CodexPromptOptions,
  CodexReasoningEffort,
  CodexSpeed,
  Member,
} from "@codex-collab/protocol";
import {
  CODEX_MODEL_OPTIONS,
  DEFAULT_CODEX_CUSTOM_PERMISSIONS,
  codexModelSupportsFast,
  codexModelSupportsImages,
  codexModelSupportsReasoningEffort,
  getCodexModelOption,
} from "@codex-collab/protocol";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { PendingAttachment } from "./attachments.js";
import {
  filterUnsupportedImageAttachments,
  normalizeCodexOptionsForUi,
  reasoningEffortLabels,
  reasoningEffortOrder,
  type CodexExecutionPhase,
} from "./codex-controls.js";

interface CodexComposerControlsProps {
  approved: boolean;
  roomOpen: boolean;
  submitting: boolean;
  memberRole: Member["role"] | null;
  attachmentInputRef: RefObject<HTMLInputElement | null>;
  preparingAttachments: boolean;
  pendingAttachments: PendingAttachment[];
  setPendingAttachments: Dispatch<SetStateAction<PendingAttachment[]>>;
  dictating: boolean;
  onToggleDictation: () => void;
  codexOptions: CodexPromptOptions;
  setCodexOptions: Dispatch<SetStateAction<CodexPromptOptions>>;
  executionPhase: CodexExecutionPhase;
  primaryStopsCodex: boolean;
  canStopCodex: boolean;
  canSendCodex: boolean;
  onError: (message: string) => void;
}

export function CodexComposerControls({
  approved,
  roomOpen,
  submitting,
  memberRole,
  attachmentInputRef,
  preparingAttachments,
  pendingAttachments,
  setPendingAttachments,
  dictating,
  onToggleDictation,
  codexOptions,
  setCodexOptions,
  executionPhase,
  primaryStopsCodex,
  canStopCodex,
  canSendCodex,
  onError,
}: CodexComposerControlsProps) {
  const model = getCodexModelOption(codexOptions.model);
  const supportsFast = codexModelSupportsFast(codexOptions.model);
  const supportsImages = codexModelSupportsImages(codexOptions.model);
  const efforts = model
    ? reasoningEffortOrder.filter((effort) =>
        codexModelSupportsReasoningEffort(model.id, effort),
      )
    : reasoningEffortOrder;
  const permissions =
    codexOptions.customPermissions ?? DEFAULT_CODEX_CUSTOM_PERMISSIONS;
  const disabled = !approved || submitting || !roomOpen;

  return (
    <>
      {model && (!supportsFast || !supportsImages) ? (
        <div className="composer-capability-note" role="status">
          <strong>{model.label}</strong>
          <span>
            {!supportsImages
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
            title={supportsImages ? "添加文件或图片" : "添加文本文件（当前模型不支持图片）"}
            aria-label={supportsImages ? "添加文件或图片" : "添加文本文件（当前模型不支持图片）"}
            disabled={disabled || preparingAttachments}
            onClick={() => attachmentInputRef.current?.click()}
          />
          <Button
            type="button"
            appearance={dictating ? "primary" : "subtle"}
            className="stable-icon-button"
            icon={dictating ? <StopRegular /> : <MicRegular />}
            title={dictating ? "停止听写" : "听写"}
            aria-label={dictating ? "停止听写" : "听写"}
            disabled={disabled}
            onClick={onToggleDictation}
          />
          <Select
            aria-label="Codex 权限"
            title="Codex 权限"
            value={codexOptions.accessMode}
            disabled={disabled || memberRole !== "owner"}
            onChange={(_, data) => {
              const accessMode = data.value as CodexAccessMode;
              setCodexOptions((current) =>
                normalizeCodexOptionsForUi({
                  ...current,
                  accessMode,
                  customPermissions:
                    accessMode === "custom"
                      ? current.customPermissions ?? { ...DEFAULT_CODEX_CUSTOM_PERMISSIONS }
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
            disabled={disabled}
            onChange={(_, data) => {
              const modelId = (data.value || null) as CodexModelId | null;
              setCodexOptions((current) =>
                normalizeCodexOptionsForUi({ ...current, model: modelId }),
              );
              const retained = filterUnsupportedImageAttachments(
                modelId,
                pendingAttachments,
              );
              if (retained.length !== pendingAttachments.length) {
                setPendingAttachments(retained);
                onError(
                  `${getCodexModelOption(modelId)?.label ?? "当前模型"} 仅支持文本，已移除待发送的图片`,
                );
              }
            }}
          >
            <option value="">跟随当前任务模型</option>
            {CODEX_MODEL_OPTIONS.map((option) => (
              <option value={option.id} key={option.id}>{option.label}</option>
            ))}
          </Select>
          <Select
            aria-label="推理强度"
            title="推理强度"
            value={codexOptions.reasoningEffort}
            disabled={disabled}
            onChange={(_, data) => {
              const reasoningEffort = data.value as CodexReasoningEffort;
              setCodexOptions((current) => ({ ...current, reasoningEffort }));
            }}
          >
            <option value="follow-desktop">跟随推理强度</option>
            {efforts.map((effort) => (
              <option value={effort} key={effort}>{reasoningEffortLabels[effort]}</option>
            ))}
          </Select>
          <Select
            aria-label="响应速度"
            title={supportsFast ? "响应速度" : `${model?.label ?? "当前模型"} 不支持快速模式`}
            value={codexOptions.speed}
            disabled={disabled}
            onChange={(_, data) => {
              const speed = data.value as CodexSpeed;
              setCodexOptions((current) => ({ ...current, speed }));
            }}
          >
            <option value="follow-desktop">跟随速度</option>
            <option value="standard">标准</option>
            <option value="fast" disabled={!supportsFast}>快速</option>
          </Select>
          <Checkbox
            label="计划模式"
            checked={codexOptions.planMode}
            disabled={disabled}
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
            title={primaryStopsCodex ? executionPhase === "stopping" ? "正在停止 Codex" : "停止 Codex" : "发送给 Codex"}
            aria-label={primaryStopsCodex ? executionPhase === "stopping" ? "正在停止 Codex" : "停止 Codex" : "发送给 Codex"}
            disabled={disabled || (primaryStopsCodex ? !canStopCodex : !canSendCodex)}
          />
        </div>
      </div>
      {codexOptions.accessMode === "custom" ? (
        <div className="custom-permission-panel" aria-label="自定义 Codex 权限">
          <Field label="文件访问">
            <Select
              size="small"
              aria-label="自定义文件访问"
              value={permissions.fileAccess}
              disabled={disabled || memberRole !== "owner"}
              onChange={(_, data) => {
                const fileAccess = data.value as CodexCustomFileAccess;
                setCodexOptions((current) => ({
                  ...current,
                  customPermissions: {
                    ...(current.customPermissions ?? DEFAULT_CODEX_CUSTOM_PERMISSIONS),
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
              value={permissions.approvalPolicy}
              disabled={disabled || memberRole !== "owner"}
              onChange={(_, data) => {
                const approvalPolicy = data.value as CodexCustomApprovalPolicy;
                setCodexOptions((current) => ({
                  ...current,
                  customPermissions: {
                    ...(current.customPermissions ?? DEFAULT_CODEX_CUSTOM_PERMISSIONS),
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
            {permissions.approvalPolicy === "on-request"
              ? "默认按所选文件范围执行，需要越权时仍会请求房主批准。"
              : "按所选文件范围自动执行，不会请求额外批准。"}
          </p>
        </div>
      ) : null}
    </>
  );
}
