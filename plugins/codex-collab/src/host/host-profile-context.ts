import type { LocalProfile, LocalProfileStore } from "../local-profile.js";
import { RelayClient } from "../relay-client.js";
import { openWorkspaceSandboxes } from "../workspace-roots.js";

export interface CurrentHostSession {
  profile: LocalProfile;
  relay: RelayClient;
}

export function publicHostProfile(profile: LocalProfile): Omit<LocalProfile, "memberToken"> {
  const { memberToken: _secret, ...safe } = profile;
  return safe;
}

export class HostProfileContext {
  constructor(readonly profiles: LocalProfileStore) {}

  async current(): Promise<CurrentHostSession> {
    const profile = await this.profiles.read();
    if (!profile) {
      throw new Error(
        "No active session. Use collab_create_session, collab_pair_host or collab_join_session first.",
      );
    }
    await openWorkspaceSandboxes(profile.projectRoot, profile.codexConfigRoot);
    return { profile, relay: new RelayClient(profile.relayUrl) };
  }
}
