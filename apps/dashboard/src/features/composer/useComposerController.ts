import type { CodexPromptOptions } from "@codex-collab/protocol";
import {
  codexModelSupportsImages,
  getCodexModelOption,
} from "@codex-collab/protocol";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  appendPendingAttachments,
  prepareAttachmentBatch,
  type PendingAttachment,
} from "./attachments.js";
import { normalizeCodexOptionsForUi } from "./codex-controls.js";
import {
  codexComposerStorageKey,
  completeCodexComposerTaskSubmission,
  emptyCodexComposerTaskState,
  loadCodexComposerTaskState,
  loadSessionChatDraft,
  persistCodexComposerTaskState,
  persistSessionChatDraft,
  type CodexComposerTaskState,
} from "./composer-scope.js";
import type {
  SpeechRecognitionConstructor,
  SpeechRecognitionLike,
} from "./speech-recognition.js";

type ComposerControllerOptions = {
  onActivity: (
    title: string,
    detail: string,
    tone?: "info" | "success" | "warning" | "danger",
  ) => void;
  roomOpen: boolean;
  selectedThreadId: string | null;
  setError: (message: string | null) => void;
  storageKey: string | null;
};

export function useComposerController({
  onActivity,
  roomOpen,
  selectedThreadId,
  setError,
  storageKey,
}: ComposerControllerOptions) {
  const [chatDraft, setChatDraft] = useState("");
  const [pendingChatAttachments, setPendingChatAttachments] = useState<
    PendingAttachment[]
  >([]);
  const [codexStates, setCodexStates] = useState<
    Record<string, CodexComposerTaskState>
  >({});
  const [preparingChatAttachments, setPreparingChatAttachments] = useState(false);
  const [preparingCodexAttachments, setPreparingCodexAttachments] = useState(false);
  const [dictating, setDictating] = useState(false);
  const [draggingChatFiles, setDraggingChatFiles] = useState(false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const chatInputRef = useRef<HTMLInputElement>(null);
  const codexTextareaRef = useRef<HTMLTextAreaElement>(null);
  const chatAttachmentInputRef = useRef<HTMLInputElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const chatPreparationEpochRef = useRef(0);
  const codexPreparationEpochRef = useRef(0);
  const chatPreparationBusyRef = useRef(false);
  const codexPreparationBusyRef = useRef(false);
  const speechRecognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const loadedChatStorageKeyRef = useRef<string | null>(null);
  const taskStorageKey = codexComposerStorageKey(storageKey, selectedThreadId);
  const codexState = taskStorageKey
    ? codexStates[taskStorageKey] ?? emptyCodexComposerTaskState()
    : emptyCodexComposerTaskState();
  const { codexOptions, draft, pendingAttachments } = codexState;

  const updateCodexState = useCallback(
    (update: SetStateAction<CodexComposerTaskState>) => {
      if (!taskStorageKey) return;
      setCodexStates((current) => {
        const previous = current[taskStorageKey] ?? emptyCodexComposerTaskState();
        const next = typeof update === "function" ? update(previous) : update;
        return { ...current, [taskStorageKey]: next };
      });
    },
    [taskStorageKey],
  );

  const setDraft = useCallback<Dispatch<SetStateAction<string>>>(
    (update) =>
      updateCodexState((current) => ({
        ...current,
        draft: typeof update === "function" ? update(current.draft) : update,
      })),
    [updateCodexState],
  );
  const setCodexOptions = useCallback<Dispatch<SetStateAction<CodexPromptOptions>>>(
    (update) =>
      updateCodexState((current) => ({
        ...current,
        codexOptions:
          typeof update === "function" ? update(current.codexOptions) : update,
      })),
    [updateCodexState],
  );
  const setPendingAttachments = useCallback<
    Dispatch<SetStateAction<PendingAttachment[]>>
  >(
    (update) =>
      updateCodexState((current) => ({
        ...current,
        pendingAttachments:
          typeof update === "function"
            ? update(current.pendingAttachments)
            : update,
      })),
    [updateCodexState],
  );

  const reset = useCallback(() => {
    setCodexStates({});
    setChatDraft("");
    setPendingChatAttachments([]);
    chatPreparationEpochRef.current += 1;
    codexPreparationEpochRef.current += 1;
    chatPreparationBusyRef.current = false;
    codexPreparationBusyRef.current = false;
    setPreparingChatAttachments(false);
    setPreparingCodexAttachments(false);
    speechRecognitionRef.current?.stop();
    loadedChatStorageKeyRef.current = null;
  }, []);

  useEffect(() => {
    if (!storageKey) return;
    if (loadedChatStorageKeyRef.current !== storageKey) {
      loadedChatStorageKeyRef.current = storageKey;
      chatPreparationEpochRef.current += 1;
      chatPreparationBusyRef.current = false;
      setPreparingChatAttachments(false);
      setChatDraft(loadSessionChatDraft(localStorage, storageKey));
      setPendingChatAttachments([]);
      return;
    }
    persistSessionChatDraft(localStorage, storageKey, chatDraft);
  }, [chatDraft, storageKey]);

  useLayoutEffect(() => {
    codexPreparationEpochRef.current += 1;
    codexPreparationBusyRef.current = false;
    setPreparingCodexAttachments(false);
    speechRecognitionRef.current?.stop();
    if (!taskStorageKey || !storageKey) return;
    const storedState = loadCodexComposerTaskState(
      localStorage,
      taskStorageKey,
      storageKey,
    );
    setCodexStates((current) =>
      current[taskStorageKey]
        ? current
        : {
            ...current,
            [taskStorageKey]: storedState,
          },
    );
  }, [storageKey, taskStorageKey]);

  useEffect(() => {
    for (const [key, state] of Object.entries(codexStates)) {
      persistCodexComposerTaskState(localStorage, key, state);
    }
  }, [codexStates]);

  useEffect(
    () => () => {
      speechRecognitionRef.current?.stop();
    },
    [],
  );

  const addChatAttachments = async (files: FileList | File[]) => {
    if (!roomOpen || chatPreparationBusyRef.current) return;
    const incoming = Array.from(files);
    if (incoming.length === 0) return;
    const preparationEpoch = chatPreparationEpochRef.current;
    chatPreparationBusyRef.current = true;
    setPreparingChatAttachments(true);
    try {
      const prepared = await prepareAttachmentBatch(incoming);
      if (preparationEpoch !== chatPreparationEpochRef.current) return;
      const merged = appendPendingAttachments(
        pendingChatAttachments,
        prepared.attachments,
      );
      setPendingChatAttachments(merged.attachments);
      setError(merged.warning ?? prepared.warnings.at(-1) ?? null);
    } finally {
      if (preparationEpoch === chatPreparationEpochRef.current) {
        chatPreparationBusyRef.current = false;
        setPreparingChatAttachments(false);
      }
    }
  };

  const addAttachments = async (files: FileList | File[]) => {
    if (!roomOpen || !taskStorageKey || codexPreparationBusyRef.current) return;
    const incoming = Array.from(files);
    if (incoming.length === 0) return;
    const modelLabel = getCodexModelOption(codexOptions.model)?.label ?? "当前模型";
    let unsupportedWarning: string | null = null;
    const allowed = incoming.filter((file) => {
      if (file.type.startsWith("image/") && !codexModelSupportsImages(codexOptions.model)) {
        unsupportedWarning = `${modelLabel} 仅支持文本，不能添加图片：${file.name}`;
        return false;
      }
      return true;
    });
    if (allowed.length === 0) {
      setError(unsupportedWarning);
      return;
    }
    const preparationEpoch = codexPreparationEpochRef.current;
    codexPreparationBusyRef.current = true;
    setPreparingCodexAttachments(true);
    try {
      const prepared = await prepareAttachmentBatch(allowed);
      if (preparationEpoch !== codexPreparationEpochRef.current) return;
      const merged = appendPendingAttachments(pendingAttachments, prepared.attachments);
      setPendingAttachments(merged.attachments);
      setError(
        merged.warning ?? prepared.warnings.at(-1) ?? unsupportedWarning ?? null,
      );
    } finally {
      if (preparationEpoch === codexPreparationEpochRef.current) {
        codexPreparationBusyRef.current = false;
        setPreparingCodexAttachments(false);
      }
    }
  };

  const toggleDictation = () => {
    if (dictating) {
      speechRecognitionRef.current?.stop();
      return;
    }
    const speechWindow = window as unknown as {
      SpeechRecognition?: SpeechRecognitionConstructor;
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    };
    const Constructor =
      speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
    if (!Constructor) {
      setError("当前浏览器不支持听写");
      return;
    }
    const recognition = new Constructor();
    recognition.lang = "zh-CN";
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      const fragments: string[] = [];
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result?.[0]?.transcript.trim();
        if (result?.isFinal && transcript) fragments.push(transcript);
      }
      if (fragments.length > 0) {
        setDraft((current) =>
          `${current}${current && !/\s$/.test(current) ? " " : ""}${fragments.join(" ")}`,
        );
      }
    };
    recognition.onerror = () => {
      setError("听写未完成，请检查浏览器麦克风权限");
      setDictating(false);
    };
    recognition.onend = () => {
      setDictating(false);
      speechRecognitionRef.current = null;
    };
    speechRecognitionRef.current = recognition;
    setDictating(true);
    recognition.start();
  };

  const showAttachmentError = useCallback(
    (caught: unknown) => {
      const message = caught instanceof Error ? caught.message : "附件读取失败";
      setError(message);
      onActivity("附件读取失败", message, "warning");
    },
    [onActivity, setError],
  );

  const completeCodexSubmission = useCallback(
    (threadId: string, submittedDraft: string, submittedAttachmentIds: string[]) => {
      const completedStorageKey = codexComposerStorageKey(storageKey, threadId);
      if (!completedStorageKey) return;
      setCodexStates((current) => {
        const previous = current[completedStorageKey];
        if (!previous) return current;
        return {
          ...current,
          [completedStorageKey]: completeCodexComposerTaskSubmission(
            previous,
            submittedDraft,
            submittedAttachmentIds,
          ),
        };
      });
    },
    [storageKey],
  );

  return {
    addAttachments,
    addChatAttachments,
    attachmentInputRef,
    chatAttachmentInputRef,
    chatDraft,
    chatInputRef,
    codexOptions,
    codexTextareaRef,
    completeCodexSubmission,
    dictating,
    draft,
    draggingChatFiles,
    draggingFiles,
    pendingAttachments,
    pendingChatAttachments,
    preparingChatAttachments,
    preparingCodexAttachments,
    reset,
    setChatDraft,
    setCodexOptions,
    setDraft,
    setDraggingChatFiles,
    setDraggingFiles,
    setPendingAttachments,
    setPendingChatAttachments,
    showAttachmentError,
    toggleDictation,
  };
}
