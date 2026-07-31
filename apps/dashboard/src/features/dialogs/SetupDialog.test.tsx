import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SetupDialogFeedback } from "./SetupDialog.js";

const noop = () => undefined;

describe("SetupDialogFeedback", () => {
  it("shows recovery failures inside the modal", () => {
    const markup = renderToStaticMarkup(createElement(SetupDialogFeedback, {
      credentialNotice: null,
      error: "Room ID or owner recovery key is invalid",
      onCredentialNoticeChange: noop,
      onErrorDismiss: noop,
    }));

    expect(markup).toContain("连接未完成");
    expect(markup).toContain("Room ID or owner recovery key is invalid");
    expect(markup).toContain('role="alert"');
  });
});
