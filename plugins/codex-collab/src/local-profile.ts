import {
  chmod,
  mkdir,
  readFile,
  rename,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface LocalProfile {
  relayUrl: string;
  sessionId: string;
  memberId: string;
  displayName: string;
  role: "owner" | "editor";
  memberToken: string;
  projectRoot: string;
  codexConfigRoot?: string;
  threadId?: string;
  lastMessageAt?: string;
  forwardedMessageIds?: string[];
  observedThreadIds?: string[];
}

type LocalProfilePatch = Omit<Partial<LocalProfile>, "observedThreadIds"> & {
  observedThreadIds?: string[] | undefined;
};

const profileLockRetryMs = 10;
const profileLockTimeoutMs = 5_000;
const staleProfileLockMs = 30_000;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function localProfilePath(): string {
  return (
    process.env.CODEX_COLLAB_STATE_FILE ??
    join(homedir(), ".codex-collab", "state.json")
  );
}

export class LocalProfileStore {
  async read(): Promise<LocalProfile | null> {
    try {
      const data = await readFile(localProfilePath(), "utf8");
      return JSON.parse(data) as LocalProfile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async withWriteLock<T>(operation: (target: string) => Promise<T>): Promise<T> {
    const target = localProfilePath();
    const lockDirectory = `${target}.lock`;
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + profileLockTimeoutMs;

    for (;;) {
      try {
        await mkdir(lockDirectory, { mode: 0o700 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const lockInfo = await stat(lockDirectory);
          if (Date.now() - lockInfo.mtimeMs > staleProfileLockMs) {
            await rmdir(lockDirectory);
            continue;
          }
        } catch (lockError) {
          if ((lockError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw lockError;
        }
        if (Date.now() >= deadline) {
          throw new Error("Timed out waiting to update the Codex Collab local profile");
        }
        await wait(profileLockRetryMs);
      }
    }

    try {
      return await operation(target);
    } finally {
      await rmdir(lockDirectory).catch(() => undefined);
    }
  }

  private async writeUnlocked(target: string, profile: LocalProfile): Promise<void> {
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(profile, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, target);
    await chmod(target, 0o600).catch(() => undefined);
  }

  async write(profile: LocalProfile): Promise<void> {
    await this.withWriteLock((target) => this.writeUnlocked(target, profile));
  }

  async update(patch: LocalProfilePatch): Promise<LocalProfile> {
    return this.withWriteLock(async (target) => {
      const current = await this.read();
      if (!current) {
        throw new Error("No active Codex Collab profile. Create or join a session first.");
      }
      const { observedThreadIds, ...profilePatch } = patch;
      const merged = { ...current, ...profilePatch };
      let updated: LocalProfile;
      if ("observedThreadIds" in patch && observedThreadIds === undefined) {
        const { observedThreadIds: _removed, ...withoutObservedThreadIds } = merged;
        updated = withoutObservedThreadIds;
      } else if (observedThreadIds !== undefined) {
        updated = { ...merged, observedThreadIds };
      } else {
        updated = merged;
      }
      await this.writeUnlocked(target, updated);
      return updated;
    });
  }
}
