import {
  turnMatchesPeerCommand,
} from "./thread-history-parser.js";
import { readCodexTurns, type AppServerRequest } from "./thread-turn-reader.js";

export async function findPeerPromptTurnIds(
  request: AppServerRequest,
  threadId: string,
  commandId: string,
): Promise<string[]> {
  const turns = await readCodexTurns(request, threadId);
  const matches = new Set<string>();
  for (const turn of turns) {
    if (turnMatchesPeerCommand(turn, commandId)) matches.add(turn.id);
  }
  return [...matches];
}
