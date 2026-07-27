import { open as openFile } from "node:fs/promises";

export const MAX_RECENT_ROLLOUT_BYTES = 20_000_000;

export async function readRecentRolloutLines(
  path: string,
  size: number,
  maxBytes = MAX_RECENT_ROLLOUT_BYTES,
): Promise<string[]> {
  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  const buffer = Buffer.alloc(length);
  const handle = await openFile(path, "r");
  try {
    let offset = 0;
    while (offset < length) {
      const result = await handle.read(buffer, offset, length - offset, start + offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    let content = buffer.subarray(0, offset).toString("utf8");
    if (start > 0) {
      const firstLineEnd = content.indexOf("\n");
      content = firstLineEnd < 0 ? "" : content.slice(firstLineEnd + 1);
    }
    return content.split(/\r?\n/);
  } finally {
    await handle.close();
  }
}

