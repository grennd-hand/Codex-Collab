import type {
  ClaimHostPairingResponse,
  CodexPromptOptions,
  CodexRecordEntry,
  CodexRuntimeStatus,
  CodexThreadCatalogEntry,
  CreateInviteResponse,
  CreateSessionResponse,
  JoinInviteResponse,
  Member,
  Message,
  MessageAttachment,
  MessageAttachmentInput,
  MessageDeliveryStatus,
  MessageKind,
  RealtimeTicketResponse,
  RecoverSessionResponse,
  WorkspaceFileAccess,
  WorkspaceFileContent,
  WorkspaceSummary,
  WorkspaceSyncState,
} from "@codex-collab/protocol";
import { RelayRequestError } from "./relay-http-transport.js";
import { WorkspaceFileRelayClient } from "./workspace-file-relay-client.js";

export { RelayRequestError } from "./relay-http-transport.js";

type WorkspaceSyncResponse =
  | { syncState: WorkspaceSyncState; workspace?: never }
  | { workspace: WorkspaceSummary; syncState?: never };

function toWorkspaceSyncState(response: WorkspaceSyncResponse): WorkspaceSyncState {
  if (response.syncState) return response.syncState;
  const { history, files, ...workspace } = response.workspace;
  return {
    ...workspace,
    historyCount: history.length,
    fileCount: files.length,
  };
}

export class RelayClient extends WorkspaceFileRelayClient {
  constructor(baseUrl: string) {
    super(baseUrl);
  }

  async health(): Promise<Record<string, unknown>> {
    return this.request("/health");
  }

  async createSession(input: {
    name: string;
    ownerDisplayName: string;
    deviceLabel?: string;
  }): Promise<CreateSessionResponse> {
    return this.request("/v1/sessions", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async recoverSession(input: {
    sessionId: string;
    recoveryKey: string;
    deviceLabel?: string;
  }): Promise<RecoverSessionResponse> {
    return this.request("/v1/sessions/recover", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async createInvite(
    sessionId: string,
    memberToken: string,
    input: { expiresInMinutes: number; maxUses: number },
  ): Promise<CreateInviteResponse> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/invites`, {
      method: "POST",
      headers: { authorization: `Bearer ${memberToken}` },
      body: JSON.stringify(input),
    });
  }

  async joinInvite(input: {
    inviteToken: string;
    displayName: string;
    deviceLabel?: string;
  }): Promise<JoinInviteResponse> {
    return this.request("/v1/invites/join", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async claimHostPairing(input: {
    pairingToken: string;
    deviceLabel: string;
    rootLabel: string;
  }): Promise<ClaimHostPairingResponse> {
    return this.request("/v1/host-pairings/claim", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async currentMember(sessionId: string, memberToken: string): Promise<Member> {
    const result = await this.request<{ member: Member }>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/me`,
      { headers: { authorization: `Bearer ${memberToken}` } },
    );
    return result.member;
  }

  async createRealtimeTicket(
    sessionId: string,
    memberToken: string,
  ): Promise<RealtimeTicketResponse> {
    return this.request(`/v1/sessions/${encodeURIComponent(sessionId)}/realtime-tickets`, {
      method: "POST",
      headers: { authorization: `Bearer ${memberToken}` },
      body: "{}",
    });
  }

  async listMembers(sessionId: string, memberToken: string): Promise<Member[]> {
    const result = await this.request<{ members: Member[] }>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/members`,
      { headers: { authorization: `Bearer ${memberToken}` } },
    );
    return result.members;
  }

  async approveMember(
    sessionId: string,
    memberToken: string,
    targetMemberId: string,
  ): Promise<Member> {
    const result = await this.request<{ member: Member }>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/members/${encodeURIComponent(
        targetMemberId,
      )}/approve`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${memberToken}` },
        body: "{}",
      },
    );
    return result.member;
  }

  async updateMemberWorkspaceFileAccess(
    sessionId: string,
    memberToken: string,
    targetMemberId: string,
    workspaceFileAccess: WorkspaceFileAccess,
  ): Promise<Member> {
    const result = await this.request<{ member: Member }>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/members/${encodeURIComponent(
        targetMemberId,
      )}/workspace-file-access`,
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${memberToken}` },
        body: JSON.stringify({ workspaceFileAccess }),
      },
    );
    return result.member;
  }

  async sendMessage(
    sessionId: string,
    memberToken: string,
    kind: MessageKind,
    body: string,
    input: {
      attachments?: MessageAttachmentInput[];
      codexOptions?: CodexPromptOptions | null;
    } = {},
  ): Promise<Message> {
    const result = await this.request<{ message: Message }>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${memberToken}` },
        body: JSON.stringify({ kind, body, ...input }),
      },
    );
    return result.message;
  }

  async readMessageAttachment(
    sessionId: string,
    memberToken: string,
    messageId: string,
    attachment: MessageAttachment,
  ): Promise<Uint8Array> {
    const content = await this.transport.requestBytes(
      `/v1/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(
        messageId,
      )}/attachments/${encodeURIComponent(attachment.id)}`,
      { authorization: `Bearer ${memberToken}` },
    );
    if (content.length !== attachment.size) {
      throw new Error(`Relay attachment size mismatch for ${attachment.name}`);
    }
    return content;
  }

  async updateMessageDeliveryStatus(
    sessionId: string,
    memberToken: string,
    messageId: string,
    status: MessageDeliveryStatus,
    codexTurnId?: string | null,
  ): Promise<Message> {
    const actionRoot = memberToken.startsWith("cch_") ? "host/messages" : "messages";
    const result = await this.request<{ message: Message }>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/${actionRoot}/${encodeURIComponent(
        messageId,
      )}/status`,
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${memberToken}` },
        body: JSON.stringify({ status, codexTurnId }),
      },
    );
    return result.message;
  }

  async listMessages(
    sessionId: string,
    memberToken: string,
    after?: string,
  ): Promise<Message[]> {
    const query = after ? `?after=${encodeURIComponent(after)}` : "";
    const result = await this.request<{ messages: Message[] }>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/messages${query}`,
      { headers: { authorization: `Bearer ${memberToken}` } },
    );
    return result.messages;
  }

  async getWorkspace(sessionId: string, memberToken: string): Promise<WorkspaceSummary> {
    const result = await this.request<{ workspace: WorkspaceSummary }>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/workspace`,
      { headers: { authorization: `Bearer ${memberToken}` } },
    );
    return result.workspace;
  }

  async getWorkspaceSyncState(
    sessionId: string,
    memberToken: string,
  ): Promise<WorkspaceSyncState> {
    try {
      const result = await this.request<WorkspaceSyncResponse>(
        `/v1/sessions/${encodeURIComponent(sessionId)}/host/workspace/sync-state`,
        { headers: { authorization: `Bearer ${memberToken}` } },
      );
      return toWorkspaceSyncState(result);
    } catch (caught) {
      if (!(caught instanceof RelayRequestError) || caught.status !== 404) throw caught;
      return toWorkspaceSyncState({
        workspace: await this.getWorkspace(sessionId, memberToken),
      });
    }
  }

  async publishWorkspaceCatalog(
    sessionId: string,
    memberToken: string,
    input: {
      deviceLabel: string;
      rootLabel: string;
      threads: CodexThreadCatalogEntry[];
    },
  ): Promise<WorkspaceSummary> {
    const result = await this.request<{ workspace: WorkspaceSummary }>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/workspace/catalog`,
      {
        method: "PUT",
        headers: { authorization: `Bearer ${memberToken}` },
        body: JSON.stringify(input),
      },
    );
    return result.workspace;
  }

  async selectWorkspaceThread(
    sessionId: string,
    memberToken: string,
    threadId: string,
  ): Promise<WorkspaceSummary> {
    const selectionPath = memberToken.startsWith("cch_")
      ? "host/workspace/selection"
      : "workspace/selection";
    const result = await this.request<{ workspace: WorkspaceSummary }>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/${selectionPath}`,
      {
        method: "PUT",
        headers: { authorization: `Bearer ${memberToken}` },
        body: JSON.stringify({ threadId }),
      },
    );
    return result.workspace;
  }

  async publishWorkspaceSnapshot(
    sessionId: string,
    memberToken: string,
    input: {
      threadId: string;
      history: CodexRecordEntry[];
      files: WorkspaceFileContent[];
      directories?: string[];
    },
  ): Promise<WorkspaceSyncState> {
    const result = await this.request<WorkspaceSyncResponse>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/workspace/snapshot`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${memberToken}`,
          prefer: "return=minimal",
        },
        body: JSON.stringify(input),
      },
    );
    return toWorkspaceSyncState(result);
  }

  async publishWorkspaceHistory(
    sessionId: string,
    memberToken: string,
    input: {
      threadId: string;
      history: CodexRecordEntry[];
    },
  ): Promise<WorkspaceSyncState> {
    const result = await this.request<WorkspaceSyncResponse>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/workspace/history`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${memberToken}`,
          prefer: "return=minimal",
        },
        body: JSON.stringify(input),
      },
    );
    return toWorkspaceSyncState(result);
  }

  async publishCodexRuntimeStatus(
    sessionId: string,
    memberToken: string,
    status: CodexRuntimeStatus,
  ): Promise<WorkspaceSyncState> {
    const result = await this.request<WorkspaceSyncResponse>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/workspace/runtime`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${memberToken}`,
          prefer: "return=minimal",
        },
        body: JSON.stringify({ status }),
      },
    );
    return toWorkspaceSyncState(result);
  }

}
