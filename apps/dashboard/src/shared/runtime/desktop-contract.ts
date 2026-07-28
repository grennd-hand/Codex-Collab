import type {
  CreateHostPairingResponse,
  CreateInviteResponse,
  Member,
  Message,
  Session,
  WorkspaceFileContent,
  WorkspaceFileOperation,
  WorkspaceHistoryPage,
  WorkspaceOverview,
  WorkspaceSummary,
} from "@codex-collab/protocol";
import type {
  CredentialSnapshotV1,
  DesktopRelayOperationV1,
  RuntimeRealtimeEventV1,
  RuntimeResponseV1,
  RuntimeResultV1,
  HostStatusV1,
  RuntimeNotificationV1,
} from "./types.js";

export interface DesktopRelayResponseBodyMapV1 {
  "health.get": { status: string };
  "session.create": {
    session: Session;
    owner: Member;
    recoveryKey: string;
  };
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

type DesktopOperationNameV1 = DesktopRelayOperationV1["operation"];

export type DesktopRelayResponseV1<
  TOperation extends DesktopOperationNameV1,
> = RuntimeResponseV1<DesktopRelayResponseBodyMapV1[TOperation]>;

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

export interface DesktopHostStatusEventV1 {
  status: HostStatusV1;
}

export interface CodexCollabDesktopApiV1 {
  readonly version: 1;
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

declare global {
  interface Window {
    codexCollabDesktop?: CodexCollabDesktopApiV1;
  }
}
