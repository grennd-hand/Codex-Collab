import type { IdeFileDocument } from "./types.js";

interface WorkspaceFileCacheEntry {
  file: IdeFileDocument;
  bytes: number;
}

export class WorkspaceFileCache {
  private readonly entries = new Map<string, WorkspaceFileCacheEntry>();
  private totalBytes = 0;

  constructor(
    private readonly maxEntries = 32,
    private readonly maxBytes = 8 * 1024 * 1024,
  ) {}

  get(key: string): IdeFileDocument | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.file;
  }

  set(key: string, file: IdeFileDocument): void {
    const bytes = new TextEncoder().encode(file.content).byteLength;
    const existing = this.entries.get(key);
    if (existing) {
      this.totalBytes -= existing.bytes;
      this.entries.delete(key);
    }
    if (bytes > this.maxBytes) return;
    this.entries.set(key, { file, bytes });
    this.totalBytes += bytes;
    this.evictOverflow();
  }

  deleteMatching(predicate: (key: string) => boolean): void {
    for (const [key, entry] of this.entries) {
      if (!predicate(key)) continue;
      this.entries.delete(key);
      this.totalBytes -= entry.bytes;
    }
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  private evictOverflow(): void {
    while (
      this.entries.size > this.maxEntries ||
      this.totalBytes > this.maxBytes
    ) {
      const oldest = this.entries.entries().next().value as
        | [string, WorkspaceFileCacheEntry]
        | undefined;
      if (!oldest) return;
      this.entries.delete(oldest[0]);
      this.totalBytes -= oldest[1].bytes;
    }
  }
}

export function workspaceRootScope(
  sessionId: string,
  hostDeviceLabel: string | null | undefined,
  rootLabel: string | null | undefined,
): string {
  return JSON.stringify([sessionId, hostDeviceLabel ?? null, rootLabel ?? null]);
}

export function workspaceFileCacheKey(
  workspaceScope: string,
  path: string,
  sha256: string,
): string {
  return JSON.stringify([workspaceScope, path, sha256]);
}
