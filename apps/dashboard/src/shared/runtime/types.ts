import type {
  CreateInviteRequest,
  CreateMessageRequest,
  CreateSessionRequest,
  CreateWorkspaceFileOperationRequest,
  JoinInviteRequest,
  Member,
  RealtimeEnvelope,
  RecoverSessionRequest,
  RoomStatus,
  Session,
  WorkspaceFileAccess,
} from "@codex-collab/protocol";

export const DASHBOARD_RUNTIME_VERSION = 1 as const;

export type DashboardRuntimeKind = "browser" | "desktop";

export type HostRuntimePhaseV1 =
  | "unpaired"
  | "active"
  | "draining"
  | "suspended"
  | "catching-up"
  | "failed";

export interface HostStatusV1 {
  version: 1;
  phase: HostRuntimePhaseV1;
  paired: boolean;
  acceptingWork: boolean;
  since: string;
  detail?: string;
}

export interface CredentialSnapshotV1 {
  session: Session;
  member: Member;
}

export interface BrowserCredentialV1 extends CredentialSnapshotV1 {
  authorization: {
    kind: "browser-bearer";
    bearerToken: string;
  };
}

export interface DesktopCredentialV1 extends CredentialSnapshotV1 {
  authorization: {
    kind: "desktop-managed";
  };
}

export type DashboardCredentialV1 =
  | BrowserCredentialV1
  | DesktopCredentialV1;

type AuthenticatedOperation<T> = T & { authorization?: string };

export type DashboardRelayOperationV1 =
  | { operation: "health.get" }
  | { operation: "session.create"; input: CreateSessionRequest }
  | { operation: "session.recover"; input: RecoverSessionRequest }
  | { operation: "invite.join"; input: JoinInviteRequest }
  | AuthenticatedOperation<{
      operation: "session.me.get";
      sessionId: string;
    }>
  | AuthenticatedOperation<{
      operation: "session.messages.list";
      sessionId: string;
    }>
  | AuthenticatedOperation<{
      operation: "session.messages.create";
      sessionId: string;
      input: CreateMessageRequest;
    }>
  | AuthenticatedOperation<{
      operation: "session.members.list";
      sessionId: string;
    }>
  | AuthenticatedOperation<{
      operation: "session.members.approve";
      sessionId: string;
      memberId: string;
    }>
  | AuthenticatedOperation<{
      operation: "session.members.workspace-access.update";
      sessionId: string;
      memberId: string;
      input: { workspaceFileAccess: WorkspaceFileAccess };
    }>
  | AuthenticatedOperation<{
      operation: "session.invites.create";
      sessionId: string;
      input: CreateInviteRequest;
    }>
  | AuthenticatedOperation<{
      operation: "session.room-status.update";
      sessionId: string;
      input: { roomStatus: RoomStatus };
    }>
  | AuthenticatedOperation<{
      operation: "session.host-pairings.create";
      sessionId: string;
      input: { expiresInMinutes: number };
    }>
  | AuthenticatedOperation<{
      operation: "workspace.overview.get";
      sessionId: string;
    }>
  | AuthenticatedOperation<{
      operation: "workspace.history-page.get";
      sessionId: string;
      input: { limit: number; before?: string };
    }>
  | AuthenticatedOperation<{
      operation: "workspace.selection.update";
      sessionId: string;
      input: { threadId: string };
    }>
  | AuthenticatedOperation<{
      operation: "workspace.file.get";
      sessionId: string;
      input: { path: string };
    }>
  | AuthenticatedOperation<{
      operation: "workspace.file-operation.create";
      sessionId: string;
      input: CreateWorkspaceFileOperationRequest;
    }>
  | AuthenticatedOperation<{
      operation: "workspace.file-operation.get";
      sessionId: string;
      operationId: string;
    }>
  | AuthenticatedOperation<{
      operation: "realtime.ticket.create";
      sessionId: string;
    }>;

type StripAuthorization<T> = T extends unknown ? Omit<T, "authorization"> : never;

export type DesktopRelayOperationV1 = Exclude<
  StripAuthorization<DashboardRelayOperationV1>,
  { operation: "realtime.ticket.create" }
>;

export interface RuntimeResponseV1<T = unknown> {
  status: number;
  body: T;
  json: boolean;
}

export interface RuntimeErrorV1 {
  status: number;
  code: string;
  message: string;
}

export class RuntimeRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeRequestError";
  }
}

export type RuntimeResultV1<T> =
  | { ok: true; value: T }
  | { ok: false; error: RuntimeErrorV1 };

export type RuntimeRealtimeEventV1 =
  | { type: "open" }
  | { type: "message"; envelope: RealtimeEnvelope }
  | { type: "close"; code: number }
  | { type: "error" };

export interface RuntimeRealtimeCallbacksV1 {
  onEvent(event: RuntimeRealtimeEventV1): void;
}

export interface RuntimeRealtimeConnectionV1 {
  close(): Promise<void>;
}

export interface RuntimeNotificationV1 {
  title: string;
  body: string;
}

export interface DashboardRuntimeV1 {
  readonly version: typeof DASHBOARD_RUNTIME_VERSION;
  readonly kind: DashboardRuntimeKind;
  readonly deviceLabel: string;
  readonly publicRelayOrigin: string;
  readonly inviteToken: string;
  readonly isLoopbackOrigin: boolean;
  request(
    operation: DashboardRelayOperationV1,
    signal?: AbortSignal,
  ): Promise<RuntimeResponseV1>;
  downloadMessageAttachment(input: {
    sessionId: string;
    messageId: string;
    attachmentId: string;
    authorization?: string;
    signal?: AbortSignal;
  }): Promise<Blob>;
  connectRealtime(
    input: {
      sessionId: string;
      authorization?: string;
    },
    callbacks: RuntimeRealtimeCallbacksV1,
  ): Promise<RuntimeRealtimeConnectionV1>;
  credentials: {
    load(): Promise<DashboardCredentialV1 | null>;
    save(credential: DashboardCredentialV1): Promise<void>;
    clear(): Promise<void>;
  };
  host: {
    getStatus(): Promise<HostStatusV1 | null>;
    onStatus(listener: (status: HostStatusV1 | null) => void): () => void;
  };
  shell: {
    openExternal(url: string): Promise<void>;
    notify(notification: RuntimeNotificationV1): Promise<void>;
  };
  clearInviteLocation(): void;
}
