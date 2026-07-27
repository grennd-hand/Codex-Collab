import { ApiRequestError, requestJson } from "../shared/api/api-client.js";
import type {
  IdeFileDocument,
  IdeFileOperationStatus,
  IdeSaveRequest,
  IdeSaveResult,
} from "./types.js";

type WorkspaceFileOperationKind = "read" | "write";

export interface WorkspaceFileOperation {
  id: string;
  sessionId: string;
  requestedByMemberId: string;
  requestedByDisplayName: string;
  kind: WorkspaceFileOperationKind;
  path: string;
  expectedSha256: string | null;
  status: IdeFileOperationStatus;
  resultFile: IdeFileDocument | null;
  errorCode: string | null;
  errorMessage: string | null;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

interface WorkspaceFileOperationResponse {
  operation: WorkspaceFileOperation;
}

interface OperationClientOptions {
  sessionId: string;
  headers: HeadersInit;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

const operationMessageByCode: Readonly<Record<string, string>> = {
  read_only: "当前成员只有项目文件只读权限。",
  codex_path_not_shared: ".codex 目录没有作为项目文件写入范围开放。",
  host_offline: "房主主机当前离线，请在主机恢复连接后重试。",
  file_not_found: "文件已不存在，请刷新文件列表。",
};

function operationPath(sessionId: string, operationId?: string): string {
  const base = `/v1/sessions/${encodeURIComponent(sessionId)}/workspace/file-operations`;
  return operationId ? `${base}/${encodeURIComponent(operationId)}` : base;
}

function workspaceFilePath(sessionId: string, path: string): string {
  return `/v1/sessions/${encodeURIComponent(sessionId)}/workspace/file?path=${encodeURIComponent(path)}`;
}

function operationError(operation: WorkspaceFileOperation): Error {
  const code = operation.errorCode ?? "file_operation_failed";
  return new ApiRequestError(
    409,
    code,
    operation.errorMessage ?? operationMessageByCode[code] ?? "文件操作未完成。",
  );
}

async function waitForOperation(
  operation: WorkspaceFileOperation,
  options: OperationClientOptions,
): Promise<WorkspaceFileOperation> {
  const startedAt = Date.now();
  let current = operation;
  while (current.status === "queued" || current.status === "processing") {
    if (Date.now() - startedAt > (options.timeoutMs ?? 90_000)) {
      throw new ApiRequestError(
        408,
        "file_operation_timeout",
        "主机尚未完成文件操作，请确认主机在线后重试。",
      );
    }
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, options.pollIntervalMs ?? 350);
    });
    current = (
      await requestJson<WorkspaceFileOperationResponse>(
        operationPath(options.sessionId, operation.id),
        { headers: options.headers },
      )
    ).operation;
  }
  return current;
}

async function enqueueOperation(
  options: OperationClientOptions,
  body:
    | { kind: "read"; path: string }
    | ({ kind: "write" } & IdeSaveRequest),
): Promise<WorkspaceFileOperation> {
  const queued = await requestJson<WorkspaceFileOperationResponse>(
    operationPath(options.sessionId),
    {
      method: "POST",
      headers: options.headers,
      body: JSON.stringify(body),
    },
  );
  return waitForOperation(queued.operation, options);
}

export async function readWorkspaceFileOperation(
  options: OperationClientOptions,
  path: string,
): Promise<IdeFileDocument> {
  const response = await requestJson<{ file: IdeFileDocument }>(
    workspaceFilePath(options.sessionId, path),
    { headers: options.headers },
  );
  return response.file;
}

export async function saveWorkspaceFileOperation(
  options: OperationClientOptions,
  request: IdeSaveRequest,
): Promise<IdeSaveResult> {
  const operation = await enqueueOperation(options, { kind: "write", ...request });
  return saveResultFromOperation(operation);
}

export function saveResultFromOperation(
  operation: WorkspaceFileOperation,
): IdeSaveResult {
  if (operation.status === "failed") {
    if (operation.errorCode === "file_conflict" && operation.resultFile) {
      return {
        status: "conflict",
        file: operation.resultFile,
        message:
          operation.errorMessage ??
          "文件在你打开后已被修改。请比较本地草稿与主机版本。",
      };
    }
    throw operationError(operation);
  }
  if (!operation.resultFile) {
    throw new ApiRequestError(
      502,
      "missing_file_result",
      "主机完成了保存，但没有返回新的文件版本。",
    );
  }
  return { status: "saved", file: operation.resultFile };
}
