import { Badge, Button } from "@fluentui/react-components";
import { HomeRegular } from "@fluentui/react-icons";
import type { AccountRoom } from "@codex-collab/protocol";

interface AccountRoomListProps {
  rooms: AccountRoom[];
  currentSessionId: string | null;
  restoringRoomId: string | null;
  onRestore: (room: AccountRoom) => void;
}

export function AccountRoomList({
  rooms,
  currentSessionId,
  restoringRoomId,
  onRestore,
}: AccountRoomListProps) {
  return (
    <div className="account-room-list" role="list" aria-label="我的房间">
      {rooms.map((room) => {
        const current = room.session.id === currentSessionId;
        const inactive =
          room.member.status === "rejected" || room.member.status === "revoked";
        const statusLabel =
          room.member.status === "pending"
            ? "等待批准"
            : room.member.status === "rejected"
              ? "已拒绝"
              : room.member.status === "revoked"
                ? "权限已撤销"
                : room.member.role === "owner"
                  ? "主人"
                  : "成员";
        const statusColor =
          room.member.status === "pending"
            ? "warning"
            : inactive
              ? "danger"
              : "success";
        return (
          <div className="account-room-item" role="listitem" key={room.session.id}>
            <div className="account-room-icon" aria-hidden="true">
              <HomeRegular />
            </div>
            <div className="account-room-copy">
              <strong>{room.session.name}</strong>
              <span>
                {room.session.roomStatus === "closed" ? "房间已关闭" : statusLabel}
                {room.lastUsedAt
                  ? `，上次使用 ${new Intl.DateTimeFormat("zh-CN", {
                      month: "numeric",
                      day: "numeric",
                    }).format(new Date(room.lastUsedAt))}`
                  : ""}
              </span>
            </div>
            <Badge appearance="tint" color={statusColor}>
              {statusLabel}
            </Badge>
            <Button
              appearance={current ? "secondary" : "primary"}
              size="small"
              aria-current={current ? "page" : undefined}
              disabled={current || inactive || restoringRoomId !== null}
              onClick={() => onRestore(room)}
            >
              {current
                ? "当前房间"
                : restoringRoomId === room.session.id
                  ? "正在进入"
                  : "进入"}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
