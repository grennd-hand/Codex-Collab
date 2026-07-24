import type {
  ClaimHostPairingResponse,
  CodexRecordEntry,
  CodexThreadCatalogEntry,
  CreateInviteResponse,
  CreateSessionResponse,
  JoinInviteResponse,
  Member,
  Message,
  MessageKind,
  WorkspaceFileContent,
  WorkspaceSummary,
} from "@codex-collab/protocol";

interface RelayErrorBody {
  error?: {
    code?: string;
    message?: string;
  };
}

export class RelayClient {
  constructor(private readonly baseUrl: string) {}

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

  async sendMessage(
    sessionId: string,
    memberToken: string,
    kind: MessageKind,
    body: string,
  ): Promise<Message> {
    const result = await this.request<{ message: Message }>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${memberToken}` },
        body: JSON.stringify({ kind, body }),
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

  async publishWorkspaceSnapshot(
    sessionId: string,
    memberToken: string,
    input: {
      threadId: string;
      history: CodexRecordEntry[];
      files: WorkspaceFileContent[];
    },
  ): Promise<WorkspaceSummary> {
    const result = await this.request<{ workspace: WorkspaceSummary }>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/workspace/snapshot`,
      {
        method: "PUT",
        headers: { authorization: `Bearer ${memberToken}` },
        body: JSON.stringify(input),
      },
    );
    return result.workspace;
  }

  private async request<T = Record<string, unknown>>(
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl), {
      ...init,
      headers: {
        "content-type": "application/json",
        ...init.headers,
      },
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await response.json()) as T & RelayErrorBody;
    if (!response.ok) {
      throw new Error(body.error?.message ?? `Relay request failed with ${response.status}`);
    }
    return body;
  }
}
