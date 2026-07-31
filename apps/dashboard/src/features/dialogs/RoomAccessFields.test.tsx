import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RoomAccessFields, RoomSubmitButton } from "./RoomAccessFields.js";

const noop = () => undefined;

const roomProps = {
  initialInviteToken: null,
  displayName: "Owner",
  roomName: "Shared task",
  joinToken: "",
  setupMode: "create" as const,
  recoverySessionId: "",
  recoveryKey: "",
  onDisplayNameChange: noop,
  onRoomNameChange: noop,
  onJoinTokenChange: noop,
  onSetupModeChange: noop,
  onRecoverySessionIdChange: noop,
  onRecoveryKeyChange: noop,
};

describe("recovery-key room access", () => {
  it("shows create, join and recovery without account controls", () => {
    const markup = renderToStaticMarkup(createElement(RoomAccessFields, roomProps));

    expect(markup).toContain("随机生成房主密钥");
    expect(markup).toContain("创建房间");
    expect(markup).toContain("邀请加入");
    expect(markup).toContain("恢复房间");
    expect(markup).not.toContain("账号");
  });

  it("keeps room creation as the primary form action", () => {
    const markup = renderToStaticMarkup(createElement(RoomSubmitButton, {
      ...roomProps,
      submitting: false,
    }));

    expect(markup).toContain("创建房间");
    expect(markup).not.toContain("disabled");
  });

  it("shows explicit progress while recovering a room", () => {
    const markup = renderToStaticMarkup(createElement(RoomSubmitButton, {
      ...roomProps,
      setupMode: "recover",
      recoverySessionId: "room-123",
      recoveryKey: "ccr_secret",
      submitting: true,
    }));

    expect(markup).toContain("正在恢复");
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("disabled");
  });
});
