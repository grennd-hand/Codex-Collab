import type {
  CreateWorkspaceFileOperationRequest,
  ReleaseWorkspaceFileOperationLeaseRequest,
  WorkspaceFileContent,
  WorkspaceFileOperation,
  WorkspaceFileOperationClaim,
  WorkspaceFileOperationConfirmation,
} from "@codex-collab/protocol";
import { RelayHttpTransport } from "./relay-http-transport.js";

export class WorkspaceFileRelayClient {
  protected readonly transport: RelayHttpTransport;

  constructor(baseUrl: string) {
    this.transport = new RelayHttpTransport(baseUrl);
  }

  async createWorkspaceFileOperation(
    sessionId: string,
    memberToken: string,
    input: CreateWorkspaceFileOperationRequest,
  ): Promise<WorkspaceFileOperation> {
    const result = await this.request<{ operation: WorkspaceFileOperation }>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/workspace/file-operations`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${memberToken}` },
        body: JSON.stringify(input),
      },
    );
    return result.operation;
  }

  async listWorkspaceFileOperations(
    sessionId: string,
    memberToken: string,
    limit = 100,
  ): Promise<WorkspaceFileOperation[]> {
    const result = await this.request<{ operations: WorkspaceFileOperation[] }>(
      `/v1/sessions/${encodeURIComponent(
        sessionId,
      )}/workspace/file-operations?limit=${encodeURIComponent(String(limit))}`,
      { headers: { authorization: `Bearer ${memberToken}` } },
    );
    return result.operations;
  }

  async getWorkspaceFileOperation(
    sessionId: string,
    memberToken: string,
    operationId: string,
  ): Promise<WorkspaceFileOperation> {
    const result = await this.request<{ operation: WorkspaceFileOperation }>(
      `/v1/sessions/${encodeURIComponent(
        sessionId,
      )}/workspace/file-operations/${encodeURIComponent(operationId)}`,
      { headers: { authorization: `Bearer ${memberToken}` } },
    );
    return result.operation;
  }

  async claimNextWorkspaceFileOperation(
    sessionId: string,
    memberToken: string,
  ): Promise<WorkspaceFileOperationClaim | null> {
    const result = await this.request<{
      operation: WorkspaceFileOperationClaim | null;
    }>(
      `/v1/sessions/${encodeURIComponent(
        sessionId,
      )}/workspace/file-operations/claim`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${memberToken}` },
        body: "{}",
      },
    );
    return result.operation;
  }

  async completeWorkspaceFileOperation(
    sessionId: string,
    memberToken: string,
    operationId: string,
    input:
      | { status: "completed"; leaseId: string; file?: WorkspaceFileContent }
      | {
          status: "failed";
          leaseId: string;
          errorCode: string;
          errorMessage: string;
          file?: WorkspaceFileContent | null;
        },
  ): Promise<WorkspaceFileOperation> {
    const result = await this.request<{ operation: WorkspaceFileOperation }>(
      `/v1/sessions/${encodeURIComponent(
        sessionId,
      )}/workspace/file-operations/${encodeURIComponent(operationId)}/result`,
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${memberToken}` },
        body: JSON.stringify(input),
      },
    );
    return result.operation;
  }

  async confirmWorkspaceFileOperationLease(
    sessionId: string,
    memberToken: string,
    operationId: string,
    leaseId: string,
  ): Promise<WorkspaceFileOperationConfirmation> {
    const result = await this.request<{ operation: WorkspaceFileOperationConfirmation }>(
      `/v1/sessions/${encodeURIComponent(
        sessionId,
      )}/workspace/file-operations/${encodeURIComponent(operationId)}/lease-confirmation`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${memberToken}` },
        body: JSON.stringify({ leaseId }),
      },
    );
    return result.operation;
  }

  async releaseWorkspaceFileOperationLease(
    sessionId: string,
    memberToken: string,
    operationId: string,
    input: ReleaseWorkspaceFileOperationLeaseRequest,
  ): Promise<WorkspaceFileOperation> {
    const result = await this.request<{ operation: WorkspaceFileOperation }>(
      `/v1/sessions/${encodeURIComponent(
        sessionId,
      )}/workspace/file-operations/${encodeURIComponent(operationId)}/lease-release`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${memberToken}` },
        body: JSON.stringify(input),
      },
    );
    return result.operation;
  }

  protected async request<T = Record<string, unknown>>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    return this.transport.request<T>(path, init);
  }
}
