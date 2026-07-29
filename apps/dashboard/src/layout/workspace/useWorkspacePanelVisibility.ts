import { useCallback, useEffect, useState } from "react";

export type WorkspacePanelVisibility = {
  collaboration: boolean;
  files: boolean;
};

const defaultVisibility: WorkspacePanelVisibility = {
  collaboration: true,
  files: true,
};

export function panelVisibilityStorageKey(scope: string): string {
  return `codex-collab:workspace:panels:${scope}`;
}

export function readWorkspacePanelVisibility(
  scope: string,
  storage: Pick<Storage, "getItem"> | null =
    typeof window === "undefined" ? null : window.localStorage,
): WorkspacePanelVisibility {
  if (!storage) return defaultVisibility;
  try {
    const stored = JSON.parse(
      storage.getItem(panelVisibilityStorageKey(scope)) ?? "null",
    ) as Partial<WorkspacePanelVisibility> | null;
    return {
      collaboration:
        typeof stored?.collaboration === "boolean"
          ? stored.collaboration
          : defaultVisibility.collaboration,
      files:
        typeof stored?.files === "boolean"
          ? stored.files
          : defaultVisibility.files,
    };
  } catch {
    return defaultVisibility;
  }
}

interface WorkspacePanelVisibilityOptions {
  allowCollaborationWithEditor?: boolean;
  editorExpanded: boolean;
  scope: string;
  setEditorExpanded: (expanded: boolean) => void;
  workspaceConnected: boolean;
}

export function useWorkspacePanelVisibility({
  allowCollaborationWithEditor = false,
  editorExpanded,
  scope,
  setEditorExpanded,
  workspaceConnected,
}: WorkspacePanelVisibilityOptions) {
  const [record, setRecord] = useState(() => ({
    scope,
    value: readWorkspacePanelVisibility(scope),
  }));
  const value =
    record.scope === scope ? record.value : readWorkspacePanelVisibility(scope);

  useEffect(() => {
    if (record.scope !== scope) {
      setRecord({ scope, value: readWorkspacePanelVisibility(scope) });
    }
  }, [record.scope, scope]);

  useEffect(() => {
    if (record.scope !== scope || typeof window === "undefined") return;
    window.localStorage.setItem(
      panelVisibilityStorageKey(scope),
      JSON.stringify(record.value),
    );
  }, [record, scope]);

  const update = useCallback(
    (key: keyof WorkspacePanelVisibility, visible: boolean) => {
      setRecord((current) => {
        const base =
          current.scope === scope
            ? current.value
            : readWorkspacePanelVisibility(scope);
        return { scope, value: { ...base, [key]: visible } };
      });
    },
    [scope],
  );

  const collaborationVisible =
    value.collaboration && (allowCollaborationWithEditor || !editorExpanded);
  const filesVisible = workspaceConnected && value.files;

  return {
    collaborationVisible,
    filesVisible,
    toggleCollaboration: () => {
      if (editorExpanded && !allowCollaborationWithEditor) {
        setEditorExpanded(false);
        update("collaboration", true);
        return;
      }
      update("collaboration", !collaborationVisible);
    },
    toggleFiles: () => {
      if (!workspaceConnected) return;
      if (filesVisible && editorExpanded) setEditorExpanded(false);
      update("files", !filesVisible);
    },
  };
}
