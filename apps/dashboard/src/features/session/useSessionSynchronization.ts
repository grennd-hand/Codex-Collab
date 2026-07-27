import type {
  Member,
  Message,
  Session,
  WorkspaceSummary,
} from "@codex-collab/protocol";
import {
  useCallback,
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { ConnectionState } from "../../app/connection.js";
import { isCredentialRejected, requestJson } from "../../shared/api/api-client.js";
import type { ActivityItem } from "../activity/ActivityPanel.js";
import type { SavedCredential } from "./session-storage.js";
import { useRealtimeConnection } from "./useRealtimeConnection.js";

type SessionSynchronizationOptions = {
  addMessage: (message: Message) => void;
  approved: boolean;
  authHeaders: (includeJson?: boolean) => HeadersInit;
  credentialValidated: boolean;
  member: Member | null;
  pushActivity: (
    title: string,
    detail: string,
    tone?: ActivityItem["tone"],
  ) => void;
  refreshWorkspace: (includeHistory?: boolean) => Promise<WorkspaceSummary | null>;
  saveCredential: (credential: SavedCredential) => void;
  session: Session | null;
  setConnection: Dispatch<SetStateAction<ConnectionState>>;
  setConversationLoading: Dispatch<SetStateAction<boolean>>;
  setCredentialValidated: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setInviteOpen: Dispatch<SetStateAction<boolean>>;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setMembers: Dispatch<SetStateAction<Member[]>>;
  setMessages: Dispatch<SetStateAction<Message[]>>;
  setWorkspaceSummary: Dispatch<SetStateAction<WorkspaceSummary | null>>;
  showError: (caught: unknown) => void;
  token: string | null;
  workspaceHistoryRequestedAtRef: MutableRefObject<number>;
};

export function useSessionSynchronization({
  addMessage,
  approved,
  authHeaders,
  credentialValidated,
  member,
  pushActivity,
  refreshWorkspace,
  saveCredential,
  session,
  setConnection,
  setConversationLoading,
  setCredentialValidated,
  setError,
  setInviteOpen,
  setLoading,
  setMembers,
  setMessages,
  setWorkspaceSummary,
  showError,
  token,
  workspaceHistoryRequestedAtRef,
}: SessionSynchronizationOptions) {
  useEffect(() => {
    if (!session || !token || credentialValidated) return;
    let stopped = false;
    setConnection("connecting");
    void requestJson<{ member: Member; session: Session }>(
      `/v1/sessions/${session.id}/me`,
      { headers: { authorization: `Bearer ${token}` } },
    )
      .then((result) => {
        if (stopped) return;
        saveCredential({
          session: result.session,
          member: result.member,
          token,
        });
        setCredentialValidated(true);
        setConnection(result.member.status === "pending" ? "waiting" : "connecting");
        setError(null);
      })
      .catch((caught: unknown) => {
        if (!stopped) showError(caught);
      });
    return () => {
      stopped = true;
    };
  }, [
    credentialValidated,
    saveCredential,
    session,
    setConnection,
    setCredentialValidated,
    setError,
    showError,
    token,
  ]);

  const refresh = useCallback(async () => {
    if (!session || !token || !approved || !member) return;
    setLoading(true);
    try {
      const [messageResult, memberResult, meResult] = await Promise.all([
        requestJson<{ messages: Message[] }>(
          `/v1/sessions/${session.id}/messages`,
          { headers: authHeaders() },
        ),
        requestJson<{ members: Member[] }>(
          `/v1/sessions/${session.id}/members`,
          { headers: authHeaders() },
        ),
        requestJson<{ member: Member; session: Session }>(
          `/v1/sessions/${session.id}/me`,
          { headers: authHeaders() },
        ),
        refreshWorkspace(),
      ]);
      setMessages(messageResult.messages);
      setMembers(memberResult.members);
      if (
        meResult.member.status !== member.status ||
        meResult.session.roomStatus !== session.roomStatus
      ) {
        saveCredential({
          session: meResult.session,
          member: meResult.member,
          token,
        });
      }
      setError(null);
    } catch (caught) {
      setConversationLoading(false);
      showError(caught);
    } finally {
      setLoading(false);
    }
  }, [
    approved,
    authHeaders,
    member,
    refreshWorkspace,
    saveCredential,
    session,
    setConversationLoading,
    setError,
    setLoading,
    setMembers,
    setMessages,
    showError,
    token,
  ]);

  useEffect(() => {
    if (approved && credentialValidated) void refresh();
  }, [approved, credentialValidated, refresh]);

  useEffect(() => {
    if (!session || !token || !credentialValidated || member?.status !== "pending") {
      return;
    }
    let stopped = false;
    let timer: number | undefined;
    const checkApproval = async () => {
      try {
        const result = await requestJson<{ member: Member; session: Session }>(
          `/v1/sessions/${session.id}/me`,
          { headers: { authorization: `Bearer ${token}` } },
        );
        if (stopped) return;
        if (result.member.status === "approved") {
          setConversationLoading(true);
          saveCredential({
            session: result.session,
            member: result.member,
            token,
          });
          setConnection("connecting");
          setError(null);
          pushActivity("主人已批准", "实时协作已启用", "success");
          return;
        }
      } catch (caught) {
        if (!stopped) {
          showError(caught);
          if (isCredentialRejected(caught)) return;
        }
      }
      if (!stopped) timer = window.setTimeout(checkApproval, 2_000);
    };
    void checkApproval();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [
    credentialValidated,
    member?.status,
    pushActivity,
    saveCredential,
    session,
    setConnection,
    setConversationLoading,
    setError,
    showError,
    token,
  ]);

  useRealtimeConnection({
    session,
    token,
    approved,
    credentialValidated,
    member,
    authHeaders,
    addMessage,
    pushActivity,
    refresh,
    refreshWorkspace,
    saveCredential,
    showError,
    setConnection,
    setError,
    setInviteOpen,
    setWorkspaceSummary,
    workspaceHistoryRequestedAtRef,
  });

  return { refresh };
}
