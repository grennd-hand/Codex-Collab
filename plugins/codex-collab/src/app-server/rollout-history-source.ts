import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import type { CodexRecordEntry } from "@codex-collab/protocol";
import { LargeRolloutHistoryReader } from "./large-rollout-history.js";
import { extractCodexRolloutEntries } from "./rollout-history-parser.js";
import { MAX_RECENT_ROLLOUT_BYTES } from "./rollout-reader.js";

export class RolloutHistorySource {
  private readonly largeReader = new LargeRolloutHistoryReader();

  async read(
    threadId: string,
    rolloutPath?: string | null,
  ): Promise<CodexRecordEntry[] | null> {
    if (
      !rolloutPath ||
      !isAbsolute(rolloutPath) ||
      extname(rolloutPath).toLowerCase() !== ".jsonl" ||
      !basename(rolloutPath).includes(threadId)
    ) {
      return null;
    }

    const resolved = await realpath(rolloutPath);
    const metadata = await stat(resolved);
    if (!metadata.isFile()) return null;
    if (metadata.size > MAX_RECENT_ROLLOUT_BYTES) {
      const history = await this.largeReader.read(resolved, metadata.size, threadId);
      return history.length > 0 ? history : null;
    }
    return extractCodexRolloutEntries(
      (await readFile(resolved, "utf8")).split(/\r?\n/),
      threadId,
    );
  }
}
