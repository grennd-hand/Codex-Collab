export interface WorkspaceSyncAdmission { isAllowed(): boolean; }

export function workspaceWorkAllowed(admission?: WorkspaceSyncAdmission): boolean {
  return admission?.isAllowed() ?? true;
}

export async function runAdmittedBatch<T>(
  limit: number,
  admission: WorkspaceSyncAdmission | undefined,
  next: () => Promise<T | null>,
): Promise<number> {
  let processed = 0;
  while (processed < limit && workspaceWorkAllowed(admission)) {
    if ((await next()) === null) break;
    processed += 1;
  }
  return processed;
}
