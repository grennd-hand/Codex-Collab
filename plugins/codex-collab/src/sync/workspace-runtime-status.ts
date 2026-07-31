import { LocalProfileStore } from "../persistence/local-profile.js";
import { RelayClient } from "../relay/relay-client.js";

export async function publishRuntimeUnavailable(
  profiles: LocalProfileStore,
): Promise<void> {
  const profile = await profiles.read();
  if (!profile || profile.role !== "owner") return;
  await new RelayClient(profile.relayUrl).publishCodexRuntimeStatus(
    profile.sessionId,
    profile.memberToken,
    "unavailable",
  );
}
