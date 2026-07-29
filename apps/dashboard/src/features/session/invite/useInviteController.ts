import type {
  CreateInviteResponse,
  Member,
  Session,
} from "@codex-collab/protocol";
import { useEffect, useRef, useState } from "react";
import { requestJson } from "../../../shared/api/api-client.js";
import { copyText } from "../../../shared/clipboard.js";
import {
  inviteLinkForCurrentOrigin,
  type SavedCredential,
  updateCredential,
} from "../session-storage.js";

type InviteControllerOptions = {
  authHeaders: (includeJson?: boolean) => HeadersInit;
  credential: SavedCredential | null;
  member: Member | null;
  onError: (caught: unknown) => void;
  pushActivity: (
    title: string,
    detail: string,
    tone?: "info" | "success" | "warning" | "danger",
  ) => void;
  roomOpen: boolean;
  saveCredential: (credential: SavedCredential) => void;
  session: Session | null;
  setError: (message: string | null) => void;
};

export function useInviteController({
  authHeaders,
  credential,
  member,
  onError,
  pushActivity,
  roomOpen,
  saveCredential,
  session,
  setError,
}: InviteControllerOptions) {
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [roomStatusUpdating, setRoomStatusUpdating] = useState(false);
  const linkRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setOpen(false);
    setLink("");
    setCopied(false);
    setCopyFailed(false);
  }, [session?.id]);

  const create = async () => {
    if (!session || !roomOpen) return;
    try {
      const result = await requestJson<CreateInviteResponse>(
        `/v1/sessions/${session.id}/invites`,
        {
          method: "POST",
          headers: authHeaders(true),
          body: JSON.stringify({ expiresInMinutes: 60, maxUses: 1 }),
        },
      );
      setLink(inviteLinkForCurrentOrigin(result.inviteToken));
      setCopied(false);
      setCopyFailed(false);
      setOpen(true);
      pushActivity("邀请已创建", "60 分钟内可使用一次", "success");
    } catch (caught) {
      onError(caught);
    }
  };

  const updateRoomStatus = async (nextOpen: boolean) => {
    if (!session || !member || !credential || member.role !== "owner") return;
    setRoomStatusUpdating(true);
    try {
      const result = await requestJson<{ session: Session }>(
        `/v1/sessions/${session.id}/room-status`,
        {
          method: "PUT",
          headers: authHeaders(true),
          body: JSON.stringify({ roomStatus: nextOpen ? "open" : "closed" }),
        },
      );
      saveCredential(updateCredential(credential, result.session, member));
      if (!nextOpen) setOpen(false);
      setError(null);
    } catch (caught) {
      onError(caught);
    } finally {
      setRoomStatusUpdating(false);
    }
  };

  const copy = async () => {
    const copiedSuccessfully = await copyText(link, linkRef.current ?? undefined);
    setCopied(copiedSuccessfully);
    setCopyFailed(!copiedSuccessfully);
    if (copiedSuccessfully) {
      pushActivity("邀请链接已复制", "可以发送给协作者", "success");
    } else {
      linkRef.current?.focus();
      linkRef.current?.select();
    }
  };

  return {
    copied,
    copy,
    copyFailed,
    create,
    link,
    linkRef,
    open,
    roomStatusUpdating,
    setOpen,
    updateRoomStatus,
  };
}
