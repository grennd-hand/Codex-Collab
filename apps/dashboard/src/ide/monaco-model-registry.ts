export interface RetainedMonacoModel {
  dispose(): void;
  isDisposed(): boolean;
  uri: { toString(): string };
}

interface ModelRegistration {
  model: RetainedMonacoModel;
  modelScope: string;
  taskUiScope: string;
  workspaceDataScope: string;
}

const retainedModels = new Map<string, ModelRegistration>();
const idsByScope = new Map<string, string>();
const scopesById = new Map<string, string>();

function hashPart(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
    hash ^= hash >>> 13;
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function safeScopeHash(scope: string): string {
  const existing = idsByScope.get(scope);
  if (existing) return existing;
  let candidate: string;
  let attempt = 0;
  do {
    const bytes = new Uint8Array(16);
    if (globalThis.crypto?.getRandomValues) {
      globalThis.crypto.getRandomValues(bytes);
      candidate = [...bytes]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    } else {
      candidate = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35]
        .map((seed) => hashPart(`${scope}:${idsByScope.size}:${attempt}`, seed))
        .join("");
    }
    attempt += 1;
  } while (scopesById.has(candidate));
  idsByScope.set(scope, candidate);
  scopesById.set(candidate, scope);
  return candidate;
}

export function monacoModelScope(
  workspaceDataScope: string,
  taskUiScope: string,
): string {
  return JSON.stringify([workspaceDataScope, taskUiScope]);
}

export function monacoModelUri(taskScope: string, path: string): string {
  const encodedPath = path
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  return `codex-collab://workspace/${safeScopeHash(taskScope)}/${encodedPath}`;
}

export function retainMonacoModel(
  workspaceDataScope: string,
  taskUiScope: string,
  modelScope: string,
  model: RetainedMonacoModel | null,
): void {
  if (!model || model.isDisposed()) return;
  retainedModels.set(model.uri.toString(), {
    model,
    modelScope,
    taskUiScope,
    workspaceDataScope,
  });
}

export function releaseTaskMonacoModels(taskUiScope: string): void {
  const releasedScopes = new Set<string>();
  for (const [uri, registration] of retainedModels) {
    if (registration.taskUiScope !== taskUiScope) continue;
    if (!registration.model.isDisposed()) registration.model.dispose();
    retainedModels.delete(uri);
    releasedScopes.add(registration.modelScope);
  }
  releaseScopeIds(releasedScopes);
}

export function releaseWorkspaceMonacoModels(workspaceDataScope: string): void {
  const releasedScopes = new Set<string>();
  for (const [uri, registration] of retainedModels) {
    if (registration.workspaceDataScope !== workspaceDataScope) continue;
    if (!registration.model.isDisposed()) registration.model.dispose();
    retainedModels.delete(uri);
    releasedScopes.add(registration.modelScope);
  }
  releaseScopeIds(releasedScopes);
}

function releaseScopeIds(scopes: ReadonlySet<string>): void {
  for (const scope of scopes) {
    const stillRetained = [...retainedModels.values()].some(
      (registration) => registration.modelScope === scope,
    );
    if (stillRetained) continue;
    const id = idsByScope.get(scope);
    if (!id) continue;
    idsByScope.delete(scope);
    scopesById.delete(id);
  }
}
