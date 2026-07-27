import type {
  AccountProfileResponse,
  AccountRoom,
  RestoreAccountRoomResponse,
} from "@codex-collab/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiRequestError } from "../../shared/api/api-client.js";
import {
  deviceLabel,
  type SavedCredential,
} from "../session/session-storage.js";
import {
  linkAccountRoom,
  loadAccountProfile,
  logoutAccount,
  passkeysAvailable,
  registerPasskey,
  restoreAccountRoom,
  signInWithPasskey,
} from "./account-client.js";

type AccountControllerOptions = {
  composerStorageKey: string | null;
  credential: SavedCredential | null;
  credentialValidated: boolean;
  onAccountName: (displayName: string) => void;
  onCredentialNotice: (notice: string | null) => void;
  onRoomRestored: (result: RestoreAccountRoomResponse) => Promise<void>;
  onSetupOpen: (open: boolean) => void;
  onSignedOut: () => void;
  pushActivity: (
    title: string,
    detail: string,
    tone?: "info" | "success" | "warning" | "danger",
  ) => void;
};

export function useAccountController({
  composerStorageKey,
  credential,
  credentialValidated,
  onAccountName,
  onCredentialNotice,
  onRoomRestored,
  onSetupOpen,
  onSignedOut,
  pushActivity,
}: AccountControllerOptions) {
  const [profile, setProfile] = useState<AccountProfileResponse | null>(null);
  const [checking, setChecking] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [displayName, setDisplayName] = useState("Owner");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoringRoomId, setRestoringRoomId] = useState<string | null>(null);
  const linkedRoomKeyRef = useRef<string | null>(null);
  const supportsPasskeys = useMemo(passkeysAvailable, []);

  const refresh = useCallback(async () => {
    try {
      const nextProfile = await loadAccountProfile();
      setProfile(nextProfile);
      setDisplayName(nextProfile.account.displayName);
      onAccountName(nextProfile.account.displayName);
      setError(null);
      return nextProfile;
    } catch (caught) {
      if (
        caught instanceof ApiRequestError &&
        caught.status === 401 &&
        caught.code === "account_required"
      ) {
        setProfile(null);
        return null;
      }
      setError(caught instanceof Error ? caught.message : "账号状态无法读取");
      return null;
    } finally {
      setChecking(false);
    }
  }, [onAccountName]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!profile || !credential || !credentialValidated) return;
    if (
      credential.member.status === "rejected" ||
      credential.member.status === "revoked" ||
      profile.rooms.some((room) => room.session.id === credential.session.id)
    ) {
      return;
    }
    const key = `${profile.account.id}:${credential.session.id}:${credential.member.id}`;
    if (linkedRoomKeyRef.current === key) return;
    linkedRoomKeyRef.current = key;
    void linkAccountRoom(profile, credential.session.id, credential.token)
      .then((nextProfile) => {
        setProfile(nextProfile);
        setError(null);
        pushActivity("房间已保存", "下次登录后可从我的房间重新进入", "success");
      })
      .catch((caught: unknown) => {
        linkedRoomKeyRef.current = null;
        setError(caught instanceof Error ? caught.message : "当前房间无法保存到账号");
      });
  }, [credential, credentialValidated, profile, pushActivity]);

  const authenticate = async (mode: "register" | "signin") => {
    if (!supportsPasskeys) {
      setError("当前页面不支持通行密钥。请使用 HTTPS 地址或本机 localhost 打开。");
      return;
    }
    if (mode === "register" && !displayName.trim()) {
      setError("请先填写显示名称");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      let nextProfile =
        mode === "register"
          ? await registerPasskey(displayName.trim())
          : await signInWithPasskey();
      if (
        credential &&
        credentialValidated &&
        credential.member.status !== "rejected" &&
        credential.member.status !== "revoked" &&
        !nextProfile.rooms.some(
          (room) => room.session.id === credential.session.id,
        )
      ) {
        nextProfile = await linkAccountRoom(
          nextProfile,
          credential.session.id,
          credential.token,
        );
      }
      setProfile(nextProfile);
      setDisplayName(nextProfile.account.displayName);
      onAccountName(nextProfile.account.displayName);
      linkedRoomKeyRef.current = null;
      setDialogOpen(false);
      onSetupOpen(!credential);
      onCredentialNotice(null);
      pushActivity(
        mode === "register" ? "账号已创建" : "账号已登录",
        nextProfile.rooms.length > 0
          ? `可恢复 ${nextProfile.rooms.length} 个房间`
          : "可以创建第一个房间",
        "success",
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "通行密钥操作未完成");
    } finally {
      setSubmitting(false);
    }
  };

  const activateRoom = async (room: AccountRoom) => {
    if (!profile) return;
    setRestoringRoomId(room.session.id);
    setError(null);
    try {
      const result = await restoreAccountRoom(
        profile,
        room.session.id,
        deviceLabel(),
      );
      await onRoomRestored(result);
      setDialogOpen(false);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "房间无法恢复");
    } finally {
      setRestoringRoomId(null);
    }
  };

  const signOut = async () => {
    if (!profile) return;
    setSubmitting(true);
    setError(null);
    try {
      await logoutAccount(profile);
      if (composerStorageKey) localStorage.removeItem(composerStorageKey);
      setProfile(null);
      linkedRoomKeyRef.current = null;
      setDialogOpen(false);
      onSignedOut();
      pushActivity("账号已退出", "本设备需要重新使用通行密钥登录", "info");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "账号退出未完成");
    } finally {
      setSubmitting(false);
    }
  };

  return {
    activateRoom,
    authenticate,
    checking,
    dialogOpen,
    displayName,
    error,
    profile,
    refresh,
    restoringRoomId,
    setDialogOpen,
    setDisplayName,
    signOut,
    submitting,
    supportsPasskeys,
  };
}
