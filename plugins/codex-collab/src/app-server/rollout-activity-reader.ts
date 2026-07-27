import { open as openFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import {
  extractCodexRolloutActivity,
  type CodexRolloutActivity,
} from "./thread-history-parser.js";

interface CachedRolloutActivity {
  size: number;
  pendingLine: string;
  activity: CodexRolloutActivity;
}

export class RolloutActivityReader {
  private readonly cache = new Map<string, CachedRolloutActivity>();

  async read(path: string, size: number): Promise<CodexRolloutActivity> {
    let cached = this.cache.get(path);
    if (cached && size < cached.size) cached = undefined;
    let offset = cached?.size ?? 0;
    let pendingLine = cached?.pendingLine ?? "";
    let activity = cached?.activity ?? {
      openTurnIds: [],
      latestObservedTurnId: null,
      latestObservedAtMs: null,
    };
    if (offset >= size) return activity;

    const handle = await openFile(path, "r");
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(Math.min(1_048_576, size - offset));
    try {
      while (offset < size) {
        const length = Math.min(buffer.length, size - offset);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
        pendingLine += decoder.write(buffer.subarray(0, bytesRead));
        const lines = pendingLine.split(/\r?\n/);
        pendingLine = lines.pop() ?? "";
        activity = extractCodexRolloutActivity(lines, activity);
      }
      pendingLine += decoder.end();
    } finally {
      await handle.close();
    }
    this.cache.set(path, { size: offset, pendingLine, activity });
    return activity;
  }

  clear(): void {
    this.cache.clear();
  }
}
