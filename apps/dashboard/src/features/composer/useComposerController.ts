import type { CodexPromptOptions } from "@codex-collab/protocol";
import {
  DEFAULT_CODEX_PROMPT_OPTIONS,
  codexModelSupportsImages,
  getCodexModelOption,
} from "@codex-collab/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  appendPendingAttachments,
  prepareAttachmentBatch,
  type PendingAttachment,
} from "./attachments.js";
import { normalizeCodexOptionsForUi } from "./codex-controls.js";
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
  setError: (message: string | null) => void;
  storageKey: string | null;
};

export function useComposerController({
  onActivity,
  roomOpen,
  setError,
  storageKey,
}: ComposerControllerOptions) {
  const [draft, setDraft] = useState("");
  const [chatDraft, setChatDraft] = useState("");
  const [pendingChatAttachments, setPendingChatAttachments] = useState<
    PendingAttachment[]
  >([]);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [preparingChatAttachments, setPreparingChatAttachments] = useState(false);
  const [preparingCodexAttachments, setPreparingCodexAttachments] = useState(false);
  const [codexOptions, setCodexOptions] = useState<CodexPromptOptions>(
    DEFAULT_CODEX_PROMPT_OPTIONS,
  );
  const [dictating, setDictating] = useState(false);
  const [draggingChatFiles, setDraggingChatFiles] = useState(false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const chatInputRef = useRef<HTMLInputElement>(null);
  const codexTextareaRef = useRef<HTMLTextAreaElement>(null);
  const chatAttachmentInputRef = useRef<HTMLInputElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const preparationEpochRef = useRef(0);
  const chatPreparationBusyRef = useRef(false);
  const codexPreparationBusyRef = useRef(false);
  const speechRecognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const loadedStorageKeyRef = useRef<string | null>(null);

  const reset = useCallback(() => {
    setDraft("");
    setChatDraft("");
    setPendingChatAttachments([]);
    setPendingAttachments([]);
    preparationEpochRef.current += 1;
    chatPreparationBusyRef.current = false;
    codexPreparationBusyRef.current = false;
    setPreparingChatAttachments(false);
    setPreparingCodexAttachments(false);
    speechRecognitionRef.current?.stop();
    loadedStorageKeyRef.current = null;
  }, []);

  useEffect(() => {
    if (!storageKey) return;
    if (loadedStorageKeyRef.current !== storageKey) {
      loadedStorageKeyRef.current = storageKey;
      try {
        const saved = JSON.parse(localStorage.getItem(storageKey) ?? "{}") as {
          draft?: unknown;
          codexDraft?: unknown;
          chatDraft?: unknown;
          codexOptions?: unknown;
          composerMode?: unknown;
        };
        const legacyDraft = typeof saved.draft === "string" ? saved.draft : "";
        setDraft(
          typeof saved.codexDraft === "string"
            ? saved.codexDraft
            : saved.composerMode === "chat"
              ? ""
              : legacyDraft,
        );
        setChatDraft(
          typeof saved.chatDraft === "string"
            ? saved.chatDraft
            : saved.composerMode === "chat"
              ? legacyDraft
              : "",
        );
        setCodexOptions(
          saved.codexOptions &&
            typeof saved.codexOptions === "object" &&
            !Array.isArray(saved.codexOptions)
            ? normalizeCodexOptionsForUi(saved.codexOptions)
            : DEFAULT_CODEX_PROMPT_OPTIONS,
        );
      } catch {
        setDraft("");
        setChatDraft("");
        setCodexOptions(DEFAULT_CODEX_PROMPT_OPTIONS);
      }
      setPendingChatAttachments([]);
      setPendingAttachments([]);
      return;
    }
    localStorage.setItem(
      storageKey,
      JSON.stringify({ codexDraft: draft, chatDraft, codexOptions }),
    );
  }, [chatDraft, codexOptions, draft, storageKey]);

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
    const preparationEpoch = preparationEpochRef.current;
    chatPreparationBusyRef.current = true;
    setPreparingChatAttachments(true);
    try {
      const prepared = await prepareAttachmentBatch(incoming);
      if (preparationEpoch !== preparationEpochRef.current) return;
      const merged = appendPendingAttachments(
        pendingChatAttachments,
        prepared.attachments,
      );
      setPendingChatAttachments(merged.attachments);
      setError(merged.warning ?? prepared.warnings.at(-1) ?? null);
    } finally {
      if (preparationEpoch === preparationEpochRef.current) {
        chatPreparationBusyRef.current = false;
        setPreparingChatAttachments(false);
      }
    }
  };

  const addAttachments = async (files: FileList | File[]) => {
    if (!roomOpen || codexPreparationBusyRef.current) return;
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
    const preparationEpoch = preparationEpochRef.current;
    codexPreparationBusyRef.current = true;
    setPreparingCodexAttachments(true);
    try {
      const prepared = await prepareAttachmentBatch(allowed);
      if (preparationEpoch !== preparationEpochRef.current) return;
      const merged = appendPendingAttachments(pendingAttachments, prepared.attachments);
      setPendingAttachments(merged.attachments);
      setError(
        merged.warning ?? prepared.warnings.at(-1) ?? unsupportedWarning ?? null,
      );
    } finally {
      if (preparationEpoch === preparationEpochRef.current) {
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

  return {
    addAttachments,
    addChatAttachments,
    attachmentInputRef,
    chatAttachmentInputRef,
    chatDraft,
    chatInputRef,
    codexOptions,
    codexTextareaRef,
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
