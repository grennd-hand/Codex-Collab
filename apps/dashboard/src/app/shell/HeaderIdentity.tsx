import { Button } from "@fluentui/react-components";
import { PersonRegular } from "@fluentui/react-icons";
import type { Member } from "@codex-collab/protocol";

interface HeaderIdentityProps {
  member: Member | null;
  accountDisplayName: string | null;
  onOpenAccount: () => void;
}

function memberStateLabel(member: Member) {
  if (member.status === "pending") return "等待批准";
  if (member.status === "rejected") return "已拒绝";
  if (member.status === "revoked") return "权限已撤销";
  return member.role === "owner" ? "房主" : "成员";
}

export function HeaderIdentity({
  member,
  accountDisplayName,
  onOpenAccount,
}: HeaderIdentityProps) {
  if (!member) {
    return (
      <Button
        appearance="subtle"
        icon={<PersonRegular />}
        className="account-button"
        aria-label={accountDisplayName ? "打开我的房间" : "登录账号"}
        onClick={onOpenAccount}
      >
        <span className="account-button-label">
          {accountDisplayName ?? "登录"}
        </span>
      </Button>
    );
  }

  const stateLabel = memberStateLabel(member);
  const label = (
    <>
      <span className="room-identity-name">{member.displayName}</span>
      <span className="room-identity-role">{stateLabel}</span>
    </>
  );

  if (accountDisplayName) {
    return (
      <Button
        appearance="subtle"
        icon={<PersonRegular />}
        className="account-button room-identity-button"
        aria-label={`当前身份 ${member.displayName}，${stateLabel}；打开我的房间`}
        onClick={onOpenAccount}
      >
        {label}
      </Button>
    );
  }

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
