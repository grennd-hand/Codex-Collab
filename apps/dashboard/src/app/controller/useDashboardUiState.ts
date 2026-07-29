import type { Member, Message, WorkspaceSummary } from "@codex-collab/protocol";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { WorkspaceHistoryWindow } from "../../features/workspace/history/workspace-history-window.js";
import type { ThemeMode } from "../shell/theme.js";

export function useDashboardUiState() {
  const [membersExpanded, setMembersExpanded] = useState(true);
  const [messageStreamPinned, setMessageStreamPinned] = useState(true);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );
  const messageStreamRef = useRef<HTMLElement>(null);
  const messageStreamPinnedRef = useRef(true);
  const chatStreamRef = useRef<HTMLDivElement>(null);
  const onMessageStreamPinnedChange = useCallback((pinned: boolean) => {
    messageStreamPinnedRef.current = pinned;
    setMessageStreamPinned(pinned);
  }, []);
  const resetMessageStream = useCallback(() => {
    messageStreamPinnedRef.current = true;
    setMessageStreamPinned(true);
  }, []);

  return {
    chatStreamRef,
    membersExpanded,
    messageStreamPinned,
    messageStreamPinnedRef,
    messageStreamRef,
    onMessageStreamPinnedChange,
    resetMessageStream,
    setMembersExpanded,
    setMessageStreamPinned,
    setThemeMode,
    themeMode,
  };
}

type DashboardUiLifecycleOptions = {
  chatStreamRef: RefObject<HTMLDivElement | null>;
  member: Member | null;
  members: Member[];
  messageStreamPinnedRef: RefObject<boolean>;
  messageStreamRef: RefObject<HTMLElement | null>;
  messages: Message[];
  setMembersExpanded: (expanded: boolean) => void;
  setThemeMode: (mode: ThemeMode) => void;
  themeMode: ThemeMode;
  workspaceHistoryPrependingRef: RefObject<boolean>;
  workspaceHistoryWindow: WorkspaceHistoryWindow;
  workspaceSummary: WorkspaceSummary | null;
};

export function useDashboardUiLifecycle({
  chatStreamRef,
  member,
  members,
  messageStreamPinnedRef,
  messageStreamRef,
  messages,
  setMembersExpanded,
  setThemeMode,
  themeMode,
  workspaceHistoryPrependingRef,
  workspaceHistoryWindow,
  workspaceSummary,
}: DashboardUiLifecycleOptions) {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => {
      setThemeMode(event.matches ? "dark" : "light");
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [setThemeMode]);

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
    document.documentElement.style.colorScheme = themeMode;
  }, [themeMode]);

  useLayoutEffect(() => {
    const stream = messageStreamRef.current;
    if (
      stream &&
      messageStreamPinnedRef.current &&
      !workspaceHistoryPrependingRef.current
    ) {
      stream.scrollTop = stream.scrollHeight;
    }
  }, [
    messageStreamRef,
    messageStreamPinnedRef,
    workspaceHistoryPrependingRef,
    workspaceHistoryWindow.threadId,
    workspaceSummary?.codexRuntimeStatus,
    workspaceHistoryWindow.items.length,
    workspaceHistoryWindow.items.at(-1)?.entry.text,
  ]);

  useLayoutEffect(() => {
    const chatStream = chatStreamRef.current;
    if (chatStream) chatStream.scrollTop = chatStream.scrollHeight;
  }, [chatStreamRef, messages.length, messages.at(-1)?.id]);

  useEffect(() => {
    if (
      member?.role === "owner" &&
      members.some((current) => current.status === "pending")
    ) {
      setMembersExpanded(true);
    }
  }, [member?.role, members, setMembersExpanded]);
}
