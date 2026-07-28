import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { EditorTabState } from "./ide-tab-state.js";
import {
  readIdeTaskState,
  reconcileTabsWithWorkspaceFiles,
  writeIdeTaskState,
} from "./ide-task-state.js";
import type { IdeWorkspaceFile } from "./types.js";

interface IdeScopedStateOptions {
  allDirectories: ReadonlySet<string>;
  files: readonly IdeWorkspaceFile[];
  taskUiScope: string;
  workspaceDataScope: string;
}

export function useIdeScopedState({
  allDirectories,
  files,
  taskUiScope,
  workspaceDataScope,
}: IdeScopedStateOptions) {
  const restoredTaskState = useMemo(
    () => readIdeTaskState(taskUiScope, workspaceDataScope),
    [taskUiScope, workspaceDataScope],
  );
  const expansionStorageKey = `codex-collab:ide:expanded:${taskUiScope}`;
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(
    () => readExpandedDirectories(expansionStorageKey),
  );
  const [tabs, setTabs] = useState<EditorTabState[]>(
    () => restoredTaskState?.tabs ?? [],
  );
  const tabsRef = useRef<EditorTabState[]>(restoredTaskState?.tabs ?? []);
  const [activePath, setActivePathState] = useState<string | null>(
    () => restoredTaskState?.activePath ?? null,
  );
  const activePathRef = useRef(activePath);

  const setActivePath = useCallback(
    (next: string | null | ((current: string | null) => string | null)) => {
      setActivePathState((current) => {
        const resolved = typeof next === "function" ? next(current) : next;
        activePathRef.current = resolved;
        return resolved;
      });
    },
    [],
  );

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

  useEffect(() => {
    writeIdeTaskState(taskUiScope, {
      activePath,
      tabs,
      workspaceDataScope,
    });
  }, [activePath, tabs, taskUiScope, workspaceDataScope]);

  useEffect(
    () => () => {
      writeIdeTaskState(taskUiScope, {
        activePath: activePathRef.current,
        tabs: tabsRef.current,
        workspaceDataScope,
      });
    },
    [taskUiScope, workspaceDataScope],
  );

  useEffect(() => {
    setTabs((current) => {
      const next = reconcileTabsWithWorkspaceFiles(current, files);
      tabsRef.current = next;
      return next;
    });
  }, [files]);

  return {
    activePath,
    expandedDirectories,
    setActivePath,
    setExpandedDirectories,
    setTabs,
    tabs,
    tabsRef,
    updateTab,
  };
}

function readExpandedDirectories(storageKey: string): Set<string> {
  try {
    if (typeof window === "undefined") return new Set();
    const stored = window.localStorage.getItem(storageKey);
    const parsed = stored ? (JSON.parse(stored) as unknown) : [];
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [],
    );
  } catch {
    return new Set();
  }
}
