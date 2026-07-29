import type {
  CreateHostPairingResponse,
  CreateInviteRequest,
  CreateInviteResponse,
  CreateMessageRequest,
  CreateSessionRequest,
  CreateWorkspaceFileOperationRequest,
  JoinInviteRequest,
  Member,
  Message,
  RealtimeEnvelope,
  RecoverSessionRequest,
  RoomStatus,
  Session,
  WorkspaceFileAccess,
  WorkspaceFileContent,
  WorkspaceFileOperation,
  WorkspaceHistoryPage,
  WorkspaceOverview,
  WorkspaceSummary,
} from "@codex-collab/protocol";

export const DESKTOP_API_VERSION = 1 as const;
export const DESKTOP_APP_URL = "codex-collab://app/index.html" as const;

export const DESKTOP_IPC = {
  runtimeInfo: "codex-collab:runtime-info",
  credentialLoad: "codex-collab:credential-load",
  credentialUpdateSnapshot: "codex-collab:credential-update-snapshot",
  credentialClear: "codex-collab:credential-clear",
  relayPerform: "codex-collab:relay-perform",
  relayDownloadAttachment: "codex-collab:relay-download-attachment",
  realtimeConnect: "codex-collab:realtime-connect",
  realtimeClose: "codex-collab:realtime-close",
  realtimeEvent: "codex-collab:realtime-event",
  hostStatus: "codex-collab:host-status",
  hostStatusEvent: "codex-collab:host-status-event",
  shellOpenExternal: "codex-collab:shell-open-external",
  shellNotify: "codex-collab:shell-notify",
} as const;

export interface CredentialSnapshotV1 {
  session: Session;
  member: Member;
}

type AuthenticatedOperation<T> = T & { authorization?: string };

export type DashboardRelayOperationV1 =
  | { operation: "health.get" }
  | { operation: "session.create"; input: CreateSessionRequest }
  | { operation: "session.recover"; input: RecoverSessionRequest }
  | { operation: "invite.join"; input: JoinInviteRequest }
  | AuthenticatedOperation<{ operation: "session.me.get"; sessionId: string }>
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
  ;

type StripAuthorization<T> = T extends unknown ? Omit<T, "authorization"> : never;

export type DesktopRelayOperationV1 = StripAuthorization<DashboardRelayOperationV1>;

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

export type RuntimeResultV1<T> =
  | { ok: true; value: T }
  | { ok: false; error: RuntimeErrorV1 };

export type RuntimeRealtimeEventV1 =
  | { type: "open" }
  | { type: "message"; envelope: RealtimeEnvelope }
  | { type: "close"; code: number }
  | { type: "error" };

export interface DesktopRuntimeInfoV1 {
  platform: "win32";
  appVersion: string;
  deviceLabel: string;
  publicRelayOrigin: string;
}

export interface DesktopRealtimeEventV1 {
  connectionId: string;
  event: RuntimeRealtimeEventV1;
}

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

export interface DesktopHostStatusEventV1 {
  status: HostStatusV1;
}

export interface RuntimeNotificationV1 {
  title: string;
  body: string;
}

export interface DesktopRelayResponseBodyMapV1 {
  "health.get": { status: string };
  "session.create": { session: Session; owner: Member; recoveryKey: string };
  "session.recover": { session: Session; owner: Member };
  "invite.join": { session: Session; member: Member };
  "session.me.get": { session: Session; member: Member };
  "session.messages.list": { messages: Message[] };
  "session.messages.create": { message: Message };
  "session.members.list": { members: Member[] };
  "session.members.approve": { member: Member };
  "session.members.workspace-access.update": { member: Member };
  "session.invites.create": CreateInviteResponse;
  "session.room-status.update": { session: Session };
  "session.host-pairings.create": CreateHostPairingResponse;
  "workspace.overview.get": { workspace: WorkspaceOverview };
  "workspace.history-page.get": { workspaceHistoryPage: WorkspaceHistoryPage };
  "workspace.selection.update": { workspace: WorkspaceSummary };
  "workspace.file.get": { file: WorkspaceFileContent };
  "workspace.file-operation.create": { operation: WorkspaceFileOperation };
  "workspace.file-operation.get": { operation: WorkspaceFileOperation };
}

export type DesktopRelayResponseV1<
  TOperation extends DesktopRelayOperationV1["operation"],
> = RuntimeResponseV1<DesktopRelayResponseBodyMapV1[TOperation]>;

export interface CodexCollabDesktopApiV1 {
  readonly version: typeof DESKTOP_API_VERSION;
  getRuntimeInfo(): Promise<RuntimeResultV1<DesktopRuntimeInfoV1>>;
  relay: {
    perform<TOperation extends DesktopRelayOperationV1>(
      operation: TOperation,
    ): Promise<
      RuntimeResultV1<DesktopRelayResponseV1<TOperation["operation"]>>
    >;
    downloadMessageAttachment(input: {
      sessionId: string;
      messageId: string;
      attachmentId: string;
    }): Promise<RuntimeResultV1<ArrayBuffer>>;
  };
  realtime: {
    connect(input: {
      sessionId: string;
    }): Promise<RuntimeResultV1<{ connectionId: string }>>;
    close(connectionId: string): Promise<RuntimeResultV1<null>>;
    onEvent(listener: (event: DesktopRealtimeEventV1) => void): () => void;
  };
  credentials: {
    load(): Promise<RuntimeResultV1<CredentialSnapshotV1 | null>>;
    updateSnapshot(
      snapshot: CredentialSnapshotV1,
    ): Promise<RuntimeResultV1<null>>;
    clear(): Promise<RuntimeResultV1<null>>;
  };
  host: {
    getStatus(): Promise<RuntimeResultV1<HostStatusV1>>;
    onStatus(listener: (event: DesktopHostStatusEventV1) => void): () => void;
  };
  shell: {
    openExternal(url: string): Promise<RuntimeResultV1<null>>;
    notify(notification: RuntimeNotificationV1): Promise<RuntimeResultV1<null>>;
  };
}
