import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalProfileStore, type LocalProfile } from "./local-profile.js";

const originalStateFile = process.env.CODEX_COLLAB_STATE_FILE;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  if (originalStateFile === undefined) {
    delete process.env.CODEX_COLLAB_STATE_FILE;
  } else {
    process.env.CODEX_COLLAB_STATE_FILE = originalStateFile;
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("LocalProfileStore", () => {
  it("serializes concurrent patches so independent fields are preserved", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-collab-profile-"));
    temporaryDirectories.push(directory);
    process.env.CODEX_COLLAB_STATE_FILE = join(directory, "state.json");

    const initial: LocalProfile = {
      relayUrl: "https://relay.example",
      sessionId: "session-1",
      memberId: "member-1",
      displayName: "Owner",
      role: "owner",
      memberToken: "member-token",
      projectRoot: "C:\\project",
      observedThreadIds: ["thread-1"],
    };
    const firstStore = new LocalProfileStore();
    const secondStore = new LocalProfileStore();
    await firstStore.write(initial);

    await Promise.all([
      firstStore.update({ lastMessageAt: "2026-07-27T00:00:00.000Z" }),
      secondStore.update({ forwardedMessageIds: ["message-1"] }),
    ]);

    await expect(firstStore.read()).resolves.toMatchObject({
      lastMessageAt: "2026-07-27T00:00:00.000Z",
      forwardedMessageIds: ["message-1"],
      observedThreadIds: ["thread-1"],
    });
  });
});
