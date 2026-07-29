import { useCallback, useRef, useState } from "react";
import { copyText } from "../../../shared/clipboard.js";
import { recoveryBundleText } from "./room-recovery.js";

export function useOwnerRecoveryController() {
  const [credential, setCredential] = useState<{
    sessionId: string;
    recoveryKey: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const bundleRef = useRef<HTMLTextAreaElement>(null);

  const present = useCallback((sessionId: string, recoveryKey: string) => {
    setCopied(false);
    setCredential({ sessionId, recoveryKey });
  }, []);

  const copy = useCallback(async () => {
    if (!credential) return;
    const copiedSuccessfully = await copyText(
      recoveryBundleText(credential.sessionId, credential.recoveryKey),
      bundleRef.current ?? undefined,
    );
    setCopied(copiedSuccessfully);
    if (!copiedSuccessfully) {
      bundleRef.current?.focus();
      bundleRef.current?.select();
    }
  }, [credential]);

  const confirmSaved = useCallback(() => {
    setCredential(null);
    setCopied(false);
  }, []);

  return {
    bundleRef,
    confirmSaved,
    copied,
    copy,
    credential,
    present,
  };
}
