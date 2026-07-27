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

describe("anonymous room access", () => {
  it("shows create, join and recovery without requiring an account", () => {
    const markup = renderToStaticMarkup(createElement(RoomAccessFields, roomProps));

    expect(markup).toContain("无需账号");
    expect(markup).toContain("创建房间");
    expect(markup).toContain("邀请加入");
    expect(markup).toContain("恢复房间");
  });

  it("keeps room creation as the primary form action", () => {
    const markup = renderToStaticMarkup(createElement(RoomSubmitButton, {
      ...roomProps,
      submitting: false,
    }));

    expect(markup).toContain("创建房间");
    expect(markup).not.toContain("disabled");
  });
});
