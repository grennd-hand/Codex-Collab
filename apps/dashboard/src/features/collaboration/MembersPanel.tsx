import {
  Avatar,
  Badge,
  Button,
  Select,
} from "@fluentui/react-components";
import {
  ChevronDownRegular,
  LockClosedRegular,
} from "@fluentui/react-icons";
import type { Member } from "@codex-collab/protocol";
import {
  memberWorkspaceFileAccess,
  type WorkspaceFileAccess,
} from "../workspace/member-file-access.js";
import type { MemberIdentity } from "./member-identity.js";
import { MemberSkeleton } from "./MemberSkeleton.js";

export interface MembersPanelProps {
  expanded: boolean;
  pendingCount: number;
  members: Member[];
  loading: boolean;
  currentMember: Member | null;
  owner: Member | undefined;
  workspaceAccessUpdatingMemberId: string | null;
  identityForMember: (memberId: string) => MemberIdentity;
  onToggle: () => void;
  onApproveMember: (member: Member) => void;
  onUpdateWorkspaceFileAccess: (
    member: Member,
    access: WorkspaceFileAccess,
  ) => void;
}

export function MembersPanel({
  expanded,
  pendingCount,
  members,
  loading,
  currentMember,
  owner,
  workspaceAccessUpdatingMemberId,
  identityForMember,
  onToggle,
  onApproveMember,
  onUpdateWorkspaceFileAccess,
}: MembersPanelProps) {
  return (
    <section className="member-section" aria-labelledby="member-section-title">
      <div className="panel-heading member-panel-heading">
        <div>
          <h2 id="member-section-title">协作成员</h2>
          <p>
            {pendingCount > 0
              ? `${pendingCount} 人等待批准`
              : "身份与访问状态"}
          </p>
        </div>
        <div className="member-heading-actions">
          <span>{members.length} 人</span>
          <Button
            appearance="subtle"
            className={`member-collapse-button ${expanded ? "expanded" : ""}`}
            icon={<ChevronDownRegular />}
            aria-label={expanded ? "折叠协作成员" : "展开协作成员"}
            aria-expanded={expanded}
            aria-controls="collaboration-member-content"
            onClick={onToggle}
          />
        </div>
      </div>

      {expanded ? (
        <div className="member-section-body" id="collaboration-member-content">
          <div className="member-list">
            {loading && members.length === 0 ? (
              <MemberSkeleton />
            ) : members.length === 0 ? (
              <div className="panel-empty">连接会话后显示成员</div>
            ) : (
              members.map((item) => {
                const identity = identityForMember(item.id);
                return (
                  <div className="member-row" key={item.id}>
                    <Avatar
                      name={item.displayName}
                      color={identity.avatarColor}
                    />
                    <div className="member-copy">
                      <strong>{item.displayName}</strong>
                      <span>{item.role === "owner" ? "主人" : "协作者"}</span>
                    </div>
                    {currentMember?.role === "owner" &&
                    item.status === "pending" ? (
                      <Button
                        appearance="primary"
                        size="small"
                        onClick={() => onApproveMember(item)}
                      >
                        批准
                      </Button>
                    ) : currentMember?.role === "owner" &&
                      item.role !== "owner" &&
                      item.status === "approved" ? (
                      <div className="member-file-access-control">
                        <Badge appearance="tint" color="success">
                          已批准
                        </Badge>
                        <Select
                          size="small"
                          aria-label={`${item.displayName} 的项目文件权限`}
                          title="仅控制已共享项目根目录，不包含 .codex 配置目录"
                          value={memberWorkspaceFileAccess(item)}
                          disabled={workspaceAccessUpdatingMemberId === item.id}
                          onChange={(_, data) =>
                            onUpdateWorkspaceFileAccess(
                              item,
                              data.value as WorkspaceFileAccess,
                            )
                          }
                        >
                          <option value="read-only">项目文件只读</option>
                          <option value="workspace-write">项目文件可写</option>
                        </Select>
                      </div>
                    ) : (
                      <Badge
                        appearance="tint"
                        color={
                          item.status === "approved" ? "success" : "warning"
                        }
                      >
                        {item.status === "approved" ? "已批准" : "等待中"}
                      </Badge>
                    )}
                  </div>
                );
              })
            )}
          </div>

          <div className="handoff-rail">
            <div className="handoff-icon" aria-hidden="true">
              <LockClosedRegular />
            </div>
            <div>
              <span>Codex 控制权</span>
              <strong>
                {owner ? `${owner.displayName} 的 Codex` : "等待绑定主人"}
              </strong>
              <p>协作者指令进入同一任务，关键操作仍由主人审批。</p>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
