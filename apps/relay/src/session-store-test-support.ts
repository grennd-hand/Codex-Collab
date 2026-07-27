import { createHash } from "node:crypto";
import { afterEach } from "vitest";
import { SessionStore } from "./session-store.js";

const stores: SessionStore[] = [];

export function createStore(): SessionStore {
  const store = new SessionStore();
  stores.push(store);
  return store;
}

export function selectIdeThread(
  store: SessionStore,
  sessionId: string,
  ownerToken: string,
  hostToken: string,
): void {
  store.publishWorkspaceCatalog(sessionId, hostToken, {
    deviceLabel: "Owner PC",
    rootLabel: "Project",
    threads: [{ id: "thread-ide", name: "IDE task", preview: "", updatedAt: null }],
  });
  store.selectWorkspaceThread(sessionId, ownerToken, "thread-ide");
}

export function publishIdeFile(
  store: SessionStore,
  sessionId: string,
  hostToken: string,
  path: string,
  content: string,
): string {
  const sha256 = createHash("sha256").update(content).digest("hex");
  store.publishWorkspaceSnapshot(sessionId, hostToken, {
    threadId: "thread-ide",
    history: [],
    files: [
      {
        path,
        content,
        size: Buffer.byteLength(content),
        modifiedAt: "2026-07-27T00:00:00.000Z",
        sha256,
      },
    ],
  });
  return sha256;
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close();
  }
});
