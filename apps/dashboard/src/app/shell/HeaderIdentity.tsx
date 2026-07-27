import { PersonRegular } from "@fluentui/react-icons";
import type { Member } from "@codex-collab/protocol";

interface HeaderIdentityProps {
  member: Member | null;
}

function memberStateLabel(member: Member) {
  if (member.status === "pending") return "等待批准";
  if (member.status === "rejected") return "已拒绝";
  if (member.status === "revoked") return "权限已撤销";
  return member.role === "owner" ? "房主" : "成员";
}

export function HeaderIdentity({ member }: HeaderIdentityProps) {
  if (!member) return null;

  const stateLabel = memberStateLabel(member);
  const label = (
    <>
      <span className="room-identity-name">{member.displayName}</span>
      <span className="room-identity-role">{stateLabel}</span>
    </>
  );

  return (
    <div
      className="room-identity"
      role="status"
      aria-label={`当前身份 ${member.displayName}，${stateLabel}`}
      title="当前房间身份"
    >
      <PersonRegular aria-hidden="true" />
      {label}
    </div>
  );
}
