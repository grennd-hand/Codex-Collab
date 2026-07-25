import { describe, expect, it } from "vitest";
import type { Member } from "@codex-collab/protocol";
import {
  buildMemberIdentityMap,
  fallbackMemberIdentity,
} from "./member-identity.js";

function member(id: string, index: number): Pick<Member, "id" | "createdAt"> {
  return {
    id,
    createdAt: `2026-07-26T00:00:${String(index).padStart(2, "0")}.000Z`,
  };
}

describe("member identities", () => {
  it("assigns the same identity regardless of input ordering", () => {
    const members = [member("owner", 0), member("guest-a", 1), member("guest-b", 2)];
    const forward = buildMemberIdentityMap(members);
    const reversed = buildMemberIdentityMap([...members].reverse());

    for (const current of members) {
      expect(forward.get(current.id)).toEqual(reversed.get(current.id));
    }
  });

  it("keeps existing identities when a later member joins", () => {
    const initial = [member("owner", 0), member("guest-a", 1)];
    const before = buildMemberIdentityMap(initial);
    const after = buildMemberIdentityMap([...initial, member("guest-b", 2)]);

    for (const current of initial) {
      expect(after.get(current.id)).toEqual(before.get(current.id));
    }
  });

  it("keeps the first ten members visually distinct", () => {
    const identities = buildMemberIdentityMap(
      Array.from({ length: 10 }, (_, index) => member(`member-${index}`, index)),
    );

    expect(new Set([...identities.values()].map((item) => item.avatarColor)).size).toBe(10);
  });

  it("provides a deterministic fallback for historical members", () => {
    expect(fallbackMemberIdentity("former-member")).toEqual(
      fallbackMemberIdentity("former-member"),
    );
  });
});
