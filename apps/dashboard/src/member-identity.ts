import { tokens } from "@fluentui/react-components";
import type { Member } from "@codex-collab/protocol";
import type { CSSProperties } from "react";

export type MemberAvatarColor =
  | "blue"
  | "marigold"
  | "purple"
  | "seafoam"
  | "cranberry"
  | "cornflower"
  | "brown"
  | "magenta"
  | "forest"
  | "steel";

export type MemberIdentityStyle = CSSProperties & {
  "--member-bubble-bg": string;
  "--member-bubble-fg": string;
  "--member-bubble-border": string;
};

export interface MemberIdentity {
  avatarColor: MemberAvatarColor;
  style: MemberIdentityStyle;
}

const palette: readonly MemberIdentity[] = [
  {
    avatarColor: "blue",
    style: {
      "--member-bubble-bg": tokens.colorPaletteBlueBackground2,
      "--member-bubble-fg": tokens.colorPaletteBlueForeground2,
      "--member-bubble-border": tokens.colorPaletteBlueBorderActive,
    },
  },
  {
    avatarColor: "marigold",
    style: {
      "--member-bubble-bg": tokens.colorPaletteMarigoldBackground2,
      "--member-bubble-fg": tokens.colorPaletteMarigoldForeground2,
      "--member-bubble-border": tokens.colorPaletteMarigoldBorderActive,
    },
  },
  {
    avatarColor: "purple",
    style: {
      "--member-bubble-bg": tokens.colorPalettePurpleBackground2,
      "--member-bubble-fg": tokens.colorPalettePurpleForeground2,
      "--member-bubble-border": tokens.colorPalettePurpleBorderActive,
    },
  },
  {
    avatarColor: "seafoam",
    style: {
      "--member-bubble-bg": tokens.colorPaletteSeafoamBackground2,
      "--member-bubble-fg": tokens.colorPaletteSeafoamForeground2,
      "--member-bubble-border": tokens.colorPaletteSeafoamBorderActive,
    },
  },
  {
    avatarColor: "cranberry",
    style: {
      "--member-bubble-bg": tokens.colorPaletteCranberryBackground2,
      "--member-bubble-fg": tokens.colorPaletteCranberryForeground2,
      "--member-bubble-border": tokens.colorPaletteCranberryBorderActive,
    },
  },
  {
    avatarColor: "cornflower",
    style: {
      "--member-bubble-bg": tokens.colorPaletteCornflowerBackground2,
      "--member-bubble-fg": tokens.colorPaletteCornflowerForeground2,
      "--member-bubble-border": tokens.colorPaletteCornflowerBorderActive,
    },
  },
  {
    avatarColor: "brown",
    style: {
      "--member-bubble-bg": tokens.colorPaletteBrownBackground2,
      "--member-bubble-fg": tokens.colorPaletteBrownForeground2,
      "--member-bubble-border": tokens.colorPaletteBrownBorderActive,
    },
  },
  {
    avatarColor: "magenta",
    style: {
      "--member-bubble-bg": tokens.colorPaletteMagentaBackground2,
      "--member-bubble-fg": tokens.colorPaletteMagentaForeground2,
      "--member-bubble-border": tokens.colorPaletteMagentaBorderActive,
    },
  },
  {
    avatarColor: "forest",
    style: {
      "--member-bubble-bg": tokens.colorPaletteForestBackground2,
      "--member-bubble-fg": tokens.colorPaletteForestForeground2,
      "--member-bubble-border": tokens.colorPaletteForestBorderActive,
    },
  },
  {
    avatarColor: "steel",
    style: {
      "--member-bubble-bg": tokens.colorPaletteSteelBackground2,
      "--member-bubble-fg": tokens.colorPaletteSteelForeground2,
      "--member-bubble-border": tokens.colorPaletteSteelBorderActive,
    },
  },
] as const;

function hashMemberId(memberId: string): number {
  let hash = 2166136261;
  for (let index = 0; index < memberId.length; index += 1) {
    hash ^= memberId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function fallbackMemberIdentity(memberId: string): MemberIdentity {
  return palette[hashMemberId(memberId) % palette.length] ?? palette[0]!;
}

export function buildMemberIdentityMap(
  members: readonly Pick<Member, "id" | "createdAt">[],
): ReadonlyMap<string, MemberIdentity> {
  const identities = new Map<string, MemberIdentity>();
  const usedColors = new Set<MemberAvatarColor>();
  const orderedMembers = [...members].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );

  for (const current of orderedMembers) {
    const start = hashMemberId(current.id) % palette.length;
    let identity = palette[start] ?? palette[0]!;
    for (let offset = 0; offset < palette.length; offset += 1) {
      const candidate = palette[(start + offset) % palette.length] ?? palette[0]!;
      if (!usedColors.has(candidate.avatarColor)) {
        identity = candidate;
        break;
      }
    }
    identities.set(current.id, identity);
    usedColors.add(identity.avatarColor);
  }

  return identities;
}
