import type { Member, Session } from "@codex-collab/protocol";
import type {
  Dispatch,
  RefObject,
  SetStateAction,
} from "react";
import type { connectionPresentation } from "./connection.js";
import type { ThemeMode } from "./shell/theme.js";
import type { ActivityItem } from "../features/activity/ActivityPanel.js";
import type { useCollaborationController } from "../features/collaboration/useCollaborationController.js";
import type { MemberIdentity } from "../features/collaboration/member-identity.js";
import type { useComposerController } from "../features/composer/useComposerController.js";
import type {
  codexExecutionPhase,
} from "../features/composer/codex-controls.js";
import type { useInviteController } from "../features/session/useInviteController.js";
import type { useOwnerRecoveryController } from "../features/session/useOwnerRecoveryController.js";
import type { useSubmissionController } from "../features/session/useSubmissionController.js";
import type {
  buildUnifiedTimeline,
} from "../features/timeline/imported-timeline.js";
import type { collectExecutionFileChanges } from "../features/timeline/readable-output.js";
import type { useWorkspaceConnectionController } from "../features/workspace/useWorkspaceConnectionController.js";
import type { useWorkspaceFileController } from "../features/workspace/useWorkspaceFileController.js";
import type { useWorkspaceHistoryController } from "../features/workspace/useWorkspaceHistoryController.js";
import type { Message } from "@codex-collab/protocol";

export type DashboardViewModel = {
  activities: ActivityItem[];
  approved: boolean;
  canSendChat: boolean;
  canSendCodex: boolean;
  canStopCodex: boolean;
  chatMessages: Message[];
  chatStreamRef: RefObject<HTMLDivElement | null>;
  codexTimeline: ReturnType<typeof buildUnifiedTimeline>;
  collaboration: ReturnType<typeof useCollaborationController>;
  composer: ReturnType<typeof useComposerController>;
  connectionStatus: ReturnType<typeof connectionPresentation>;
  conversationInitialLoading: boolean;
  credentialNotice: string | null;
  error: string | null;
  executionEntryCount: number;
  executionPhase: ReturnType<typeof codexExecutionPhase>;
  hasCodexContent: boolean;
  hasRunningExecutionEntry: boolean;
  hiddenUnassignedMessageCount: number;
  identityForMember: (memberId: string) => MemberIdentity;
  initialInviteToken: string;
  invite: ReturnType<typeof useInviteController>;
  loading: boolean;
  member: Member | null;
  members: Member[];
  membersExpanded: boolean;
  messageStreamPinned: boolean;
  messageStreamRef: RefObject<HTMLElement | null>;
  onMessageStreamPinnedChange: (pinned: boolean) => void;
  owner: Member | undefined;
  ownerRecovery: ReturnType<typeof useOwnerRecoveryController>;
  pendingMemberCount: number;
  primaryStopsCodex: boolean;
  refresh: () => Promise<void>;
  resetSession: () => void;
  roomOpen: boolean;
  session: Session | null;
  setCredentialNotice: Dispatch<SetStateAction<string | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setMembersExpanded: Dispatch<SetStateAction<boolean>>;
  setSetupOpen: Dispatch<SetStateAction<boolean>>;
  setThemeMode: Dispatch<SetStateAction<ThemeMode>>;
  setupOpen: boolean;
  showError: (caught: unknown) => void;
  submission: ReturnType<typeof useSubmissionController>;
  themeMode: ThemeMode;
  token: string | null;
  workspaceConnected: boolean;
  workspaceConnection: ReturnType<typeof useWorkspaceConnectionController>;
  workspaceFileChanges: ReturnType<typeof collectExecutionFileChanges>;
  workspaceFiles: ReturnType<typeof useWorkspaceFileController>;
  workspaceHistory: ReturnType<typeof useWorkspaceHistoryController>;
  workspaceReadOnly: boolean;
};
