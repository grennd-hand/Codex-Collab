import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildFileTree,
  collectDirectoryPaths,
  filterFileTree,
} from "./file-tree.js";
import {
  createLoadingTab,
  createReadyTab,
  fileName,
  messageFromError,
  type EditorTabState,
} from "./ide-tab-state.js";
import type { IdeSaveResult, IdeWorkspaceProps } from "./types.js";
import type { IdeTreeSelection } from "./ide-create-entry.js";

type IdeWorkspaceStateOptions = Pick<
  IdeWorkspaceProps,
  | "files"
  | "directories"
  | "onCreateDirectory"
  | "onCreateFile"
  | "onRenameEntry"
  | "onEditorExpandedChange"
  | "onReadFile"
  | "onSaveFile"
  | "openFileRequest"
  | "readOnly"
  | "storageScope"
>;

export function useIdeWorkspaceState({
  files,
  directories = [],
  onCreateDirectory,
  onCreateFile,
  onRenameEntry,
  onEditorExpandedChange,
  onReadFile,
  onSaveFile,
  openFileRequest = null,
  readOnly,
  storageScope = "workspace",
}: IdeWorkspaceStateOptions) {
  const tree = useMemo(
    () => buildFileTree(files, directories),
    [directories, files],
  );
  const [query, setQuery] = useState("");
  const visibleTree = useMemo(() => filterFileTree(tree, query), [query, tree]);
  const allDirectories = useMemo(() => collectDirectoryPaths(tree), [tree]);
  const expansionStorageKey = `codex-collab:ide:expanded:${storageScope}`;
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(
    () => {
      try {
        if (typeof window === "undefined") return new Set();
        const stored = window.localStorage.getItem(expansionStorageKey);
        const parsed = stored ? (JSON.parse(stored) as unknown) : [];
        return new Set(
          Array.isArray(parsed)
            ? parsed.filter((item): item is string => typeof item === "string")
            : [],
        );
      } catch {
        return new Set();
      }
    },
  );
  const [tabs, setTabs] = useState<EditorTabState[]>([]);
  const tabsRef = useRef<EditorTabState[]>([]);
  const loadingPathsRef = useRef(new Map<string, Promise<void>>());
  const handledOpenRequestRef = useRef<number | null>(null);
  const shellRef = useRef<HTMLElement>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [mobileExplorerOpen, setMobileExplorerOpen] = useState(false);

  useEffect(() => {
    setExpandedDirectories((current) => {
      const next = new Set([...current].filter((path) => allDirectories.has(path)));
      return next.size === current.size ? current : next;
    });
  }, [allDirectories]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        expansionStorageKey,
        JSON.stringify([...expandedDirectories]),
      );
    } catch {
      // Local layout preferences are optional.
    }
  }, [expandedDirectories, expansionStorageKey]);

  const updateTab = useCallback(
    (path: string, update: (tab: EditorTabState) => EditorTabState) => {
      setTabs((current) => {
        const next = current.map((tab) =>
          tab.path === path ? update(tab) : tab,
        );
        tabsRef.current = next;
        return next;
      });
    },
    [],
  );

  const loadFile = useCallback(
    async (path: string) => {
      onEditorExpandedChange?.(true);
      setActivePath(path);
      setMobileExplorerOpen(false);
      const ancestorPaths = path
        .replaceAll("\\", "/")
        .split("/")
        .slice(0, -1)
        .map((_part, index, parts) => parts.slice(0, index + 1).join("/"));
      setExpandedDirectories((current) => new Set([...current, ...ancestorPaths]));
      const existing = tabsRef.current.find((tab) => tab.path === path);
      if (existing && existing.status !== "error") return;
      const inFlight = loadingPathsRef.current.get(path);
      if (inFlight) return inFlight;

      if (!existing) {
        setTabs((current) => {
          const next = current.some((tab) => tab.path === path)
            ? current
            : [...current, createLoadingTab(path)];
          tabsRef.current = next;
          return next;
        });
      } else {
        updateTab(path, (tab) => ({ ...tab, status: "loading", error: null }));
      }

      const request = (async () => {
        try {
          const document = await onReadFile(path);
          updateTab(path, (tab) => ({
            ...tab,
            status: "ready",
            value: document.content,
            savedValue: document.content,
            sha256: document.sha256,
            error: null,
            saveError: null,
            conflict: null,
          }));
        } catch (caught) {
          updateTab(path, (tab) => ({
            ...tab,
            status: "error",
            error: messageFromError(caught),
          }));
        } finally {
          loadingPathsRef.current.delete(path);
        }
      })();
      loadingPathsRef.current.set(path, request);
      return request;
    },
    [onEditorExpandedChange, onReadFile, updateTab],
  );

  const activeTab = tabs.find((tab) => tab.path === activePath) ?? null;

  const expandAncestors = useCallback((path: string) => {
    const ancestorPaths = path
      .replaceAll("\\", "/")
      .split("/")
      .slice(0, -1)
      .map((_part, index, parts) => parts.slice(0, index + 1).join("/"));
    setExpandedDirectories((current) => new Set([...current, ...ancestorPaths]));
  }, []);

  const createFile = useCallback(
    async (path: string) => {
      const document = await onCreateFile(path);
      const nextTab = createReadyTab(document);
      setTabs((current) => {
        const next = [...current.filter((tab) => tab.path !== path), nextTab];
        tabsRef.current = next;
        return next;
      });
      setActivePath(path);
      setMobileExplorerOpen(false);
      onEditorExpandedChange?.(true);
      expandAncestors(path);
    },
    [expandAncestors, onCreateFile, onEditorExpandedChange],
  );

  const createDirectory = useCallback(
    async (path: string) => {
      await onCreateDirectory(path);
      setExpandedDirectories((current) => new Set([...current, path]));
    },
    [onCreateDirectory],
  );

  const renameEntry = useCallback(
    async (entry: IdeTreeSelection, destinationPath: string) => {
      const affected = (path: string) =>
        path === entry.path ||
        (entry.kind === "directory" && path.startsWith(`${entry.path}/`));
      if (
        tabsRef.current.some(
          (tab) => tab.status === "ready" && affected(tab.path) && tab.value !== tab.savedValue,
        )
      ) {
        throw new Error("请先保存该文件夹中已修改的文件，再重命名。");
      }
      const expectedSha256 =
        entry.kind === "file"
          ? files.find((file) => file.path === entry.path)?.sha256 ?? null
          : null;
      if (entry.kind === "file" && !expectedSha256) {
        throw new Error("文件版本已过期，请刷新后重试。");
      }
      const result = await onRenameEntry({
        path: entry.path,
        destinationPath,
        expectedSha256,
      });
      const remap = (path: string) =>
        path === entry.path
          ? destinationPath
          : entry.kind === "directory" && path.startsWith(`${entry.path}/`)
            ? `${destinationPath}${path.slice(entry.path.length)}`
            : path;
      setTabs((current) => {
        const next = current.map((tab) => {
          if (!affected(tab.path)) return tab;
          const path = remap(tab.path);
          return result && tab.path === entry.path
            ? {
                ...tab,
                path,
                sha256: result.sha256,
                value: result.content,
                savedValue: result.content,
              }
            : { ...tab, path };
        });
        tabsRef.current = next;
        return next;
      });
      setActivePath((current) => (current ? remap(current) : null));
      setExpandedDirectories((current) =>
        new Set([...current].map(remap)),
      );
    },
    [files, onRenameEntry],
  );

  useEffect(() => {
    if (
      !openFileRequest ||
      handledOpenRequestRef.current === openFileRequest.requestId
    ) {
      return;
    }
    handledOpenRequestRef.current = openFileRequest.requestId;
    void loadFile(openFileRequest.path);
  }, [loadFile, openFileRequest]);

  const saveTab = useCallback(
    async (path: string) => {
      const tab = tabs.find((candidate) => candidate.path === path);
      if (
        !tab ||
        tab.status !== "ready" ||
        tab.saving ||
        tab.value === tab.savedValue ||
        readOnly ||
        path.startsWith(".codex/") ||
        tab.conflict
      ) {
        return;
      }
      updateTab(path, (current) => ({
        ...current,
        saving: true,
        saveError: null,
        savedNotice: false,
      }));
      try {
        const result: IdeSaveResult = await onSaveFile({
          path,
          content: tab.value,
          expectedSha256: tab.sha256,
        });
        if (result.status === "conflict") {
          updateTab(path, (current) => ({
            ...current,
            saving: false,
            conflict: {
              remote: result.file,
              message:
                result.message ??
                "文件在你打开后已被修改。请比较本地草稿与主机版本。",
            },
          }));
          return;
        }
        updateTab(path, (current) => ({
          ...current,
          saving: false,
          value: result.file.content,
          savedValue: result.file.content,
          sha256: result.file.sha256,
          savedNotice: true,
          conflict: null,
        }));
      } catch (caught) {
        updateTab(path, (current) => ({
          ...current,
          saving: false,
          saveError: messageFromError(caught),
        }));
      }
    },
    [onSaveFile, readOnly, tabs, updateTab],
  );

  useEffect(() => {
    const handleSaveShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
      if (!shellRef.current?.contains(document.activeElement)) return;
      event.preventDefault();
      if (activePath) void saveTab(activePath);
    };
    window.addEventListener("keydown", handleSaveShortcut);
    return () => window.removeEventListener("keydown", handleSaveShortcut);
  }, [activePath, saveTab]);

  const closeTab = (path: string) => {
    const target = tabs.find((tab) => tab.path === path);
    if (
      target?.status === "ready" &&
      target.value !== target.savedValue &&
      !window.confirm(`关闭 ${fileName(path)} 并放弃未保存的更改吗？`)
    ) {
      return;
    }
    const index = tabs.findIndex((tab) => tab.path === path);
    const next = tabs.filter((tab) => tab.path !== path);
    setTabs(next);
    tabsRef.current = next;
    if (activePath === path) {
      setActivePath(next[Math.min(index, next.length - 1)]?.path ?? null);
    }
  };

  const keepLocalDraft = () => {
    if (!activeTab?.conflict) return;
    updateTab(activeTab.path, (tab) => ({
      ...tab,
      savedValue: tab.conflict?.remote.content ?? tab.savedValue,
      sha256: tab.conflict?.remote.sha256 ?? tab.sha256,
      conflict: null,
      saveError: null,
    }));
  };

  const useRemoteVersion = () => {
    if (!activeTab?.conflict) return;
    updateTab(activeTab.path, (tab) => {
      const remote = tab.conflict?.remote;
      if (!remote) return tab;
      return {
        ...tab,
        value: remote.content,
        savedValue: remote.content,
        sha256: remote.sha256,
        conflict: null,
        saveError: null,
        savedNotice: false,
      };
    });
  };

  return {
    activePath,
    activeTab,
    closeTab,
    createDirectory,
    createFile,
    expandedDirectories,
    keepLocalDraft,
    loadFile,
    mobileExplorerOpen,
    query,
    renameEntry,
    saveTab,
    setActivePath,
    setExpandedDirectories,
    setMobileExplorerOpen,
    setQuery,
    shellRef,
    tabs,
    updateTab,
    useRemoteVersion,
    visibleTree,
  };
}
