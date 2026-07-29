import { WorkspaceOperationCompletionStore } from "../workspace/workspace-operation-completion-store.js";

export type {
  AccountChallenge,
  AccountSessionIdentity,
  StoredAccountCredential,
} from "../storage/session-store-types.js";

/**
 * Stable public facade for Relay persistence.
 *
 * Domain behavior lives in the account, collaboration, workspace, and storage modules. The
 * inheritance chain is implementation-only; callers keep the original SessionStore API.
 */
export class SessionStore extends WorkspaceOperationCompletionStore {}
