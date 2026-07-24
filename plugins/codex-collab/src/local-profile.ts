import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
}

function profilePath(): string {
  return (
    process.env.CODEX_COLLAB_STATE_FILE ??
    join(homedir(), ".codex-collab", "state.json")
  );
}

export class LocalProfileStore {
  async read(): Promise<LocalProfile | null> {
    try {
      const data = await readFile(profilePath(), "utf8");
      return JSON.parse(data) as LocalProfile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async write(profile: LocalProfile): Promise<void> {
    const target = profilePath();
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(profile, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, target);
    await chmod(target, 0o600).catch(() => undefined);
  }

  async update(patch: Partial<LocalProfile>): Promise<LocalProfile> {
    const current = await this.read();
    if (!current) {
      throw new Error("No active Codex Collab profile. Create or join a session first.");
    }
    const updated = { ...current, ...patch };
    await this.write(updated);
    return updated;
  }
}
