import { useEffect, useRef } from "react";
import { releaseIdeTaskStates } from "./ide-task-state.js";
import { releaseWorkspaceMonacoModels } from "../editor/monaco-model-registry.js";

export function useIdeWorkspaceRelease(workspaceDataScope: string): void {
  const previousDataScopeRef = useRef(workspaceDataScope);
  useEffect(() => {
    const previousScope = previousDataScopeRef.current;
    if (previousScope === workspaceDataScope) return;
    releaseWorkspaceMonacoModels(previousScope);
    releaseIdeTaskStates(previousScope);
    previousDataScopeRef.current = workspaceDataScope;
  }, [workspaceDataScope]);
}
