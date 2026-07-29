import { describe, expect, it } from "vitest";
import type { SessionStore } from "../application/session-store.js";
import { createStore } from "../testing/session-store-test-support.js";

function addCodexCommand(store: SessionStore) {
  const created = store.createSession("Delivery room", "Owner");
  const pairing = store.createHostPairing(created.session.id, created.memberToken, 10);
  const host = store.claimHostPairing(pairing.pairingToken, "Owner PC", "Project");
  store.publishWorkspaceCatalog(created.session.id, host.memberToken, {
    deviceLabel: "Owner PC",
    rootLabel: "Project",
    threads: [{ id: "thread-1", name: "Task", preview: "", updatedAt: null }],
  });
  store.selectWorkspaceThread(created.session.id, created.memberToken, "thread-1");
  const message = store.addMessage(
    created.session.id,
    created.memberToken,
    "codex_prompt",
    "Run",
    { expectedWorkspaceThreadId: "thread-1" },
  );
  return { created, host, message };
}

function expectConflict(action: () => unknown, code: string): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ statusCode: 409, code });
}

describe("SessionStore Codex message delivery", () => {
  it("keeps submitted and terminal updates idempotent", () => {
    const store = createStore();
    const { created, message } = addCodexCommand(store);

    const submitted = store.updateMessageDeliveryStatus(
      created.session.id,
      created.memberToken,
      message.id,
      "submitted",
      "turn-1",
    );
    expect(
      store.updateMessageDeliveryStatus(
        created.session.id,
        created.memberToken,
        message.id,
        "submitted",
        "turn-1",
      ),
    ).toEqual(submitted);

    store.updateMessageDeliveryStatus(
      created.session.id,
      created.memberToken,
      message.id,
      "completed",
      "turn-1",
    );
    const fixedCompletedAt = "2026-07-29T00:00:00.000Z";
    store.db
      .prepare("UPDATE messages SET completed_at = ? WHERE id = ?")
      .run(fixedCompletedAt, message.id);
    const repeated = store.updateMessageDeliveryStatus(
      created.session.id,
      created.memberToken,
      message.id,
      "completed",
      "turn-1",
    );
    expect(repeated).toMatchObject({
      deliveryStatus: "completed",
      codexTurnId: "turn-1",
      completedAt: fixedCompletedAt,
    });
  });

  it("does not regress a terminal command when a submitted receipt is replayed", () => {
    const store = createStore();
    const { created, host, message } = addCodexCommand(store);
    store.updateMessageDeliveryStatusFromHost(
      created.session.id,
      host.memberToken,
      message.id,
      "submitted",
      "turn-1",
    );
    const terminal = store.updateMessageDeliveryStatusFromHost(
      created.session.id,
      host.memberToken,
      message.id,
      "failed",
      "turn-1",
    );

    expectConflict(
      () =>
        store.updateMessageDeliveryStatusFromHost(
          created.session.id,
          host.memberToken,
          message.id,
          "submitted",
          "turn-2",
        ),
      "codex_turn_conflict",
    );

    const replayed = store.updateMessageDeliveryStatusFromHost(
      created.session.id,
      host.memberToken,
      message.id,
      "submitted",
      "turn-1",
    );
    expect(replayed).toMatchObject({
      deliveryStatus: "failed",
      codexTurnId: "turn-1",
      completedAt: terminal.completedAt,
    });
  });

  it("rejects conflicting turns and non-monotonic terminal changes", () => {
    const store = createStore();
    const { created, message } = addCodexCommand(store);
    store.updateMessageDeliveryStatus(
      created.session.id,
      created.memberToken,
      message.id,
      "submitted",
      "turn-1",
    );

    expectConflict(
      () =>
        store.updateMessageDeliveryStatus(
          created.session.id,
          created.memberToken,
          message.id,
          "submitted",
          "turn-2",
        ),
      "codex_turn_conflict",
    );
    store.updateMessageDeliveryStatus(
      created.session.id,
      created.memberToken,
      message.id,
      "completed",
      "turn-1",
    );
    expectConflict(
      () =>
        store.updateMessageDeliveryStatus(
          created.session.id,
          created.memberToken,
          message.id,
          "failed",
          "turn-1",
        ),
      "message_delivery_conflict",
    );

    const failed = addCodexCommand(store);
    store.updateMessageDeliveryStatus(
      failed.created.session.id,
      failed.created.memberToken,
      failed.message.id,
      "failed",
    );
    expectConflict(
      () =>
        store.updateMessageDeliveryStatus(
          failed.created.session.id,
          failed.created.memberToken,
          failed.message.id,
          "completed",
        ),
      "message_delivery_conflict",
    );
  });

  it("preserves queued rejection while rejecting other skipped transitions", () => {
    const store = createStore();
    const rejected = addCodexCommand(store);
    expect(
      store.updateMessageDeliveryStatus(
        rejected.created.session.id,
        rejected.created.memberToken,
        rejected.message.id,
        "failed",
      ).deliveryStatus,
    ).toBe("failed");

    const skipped = addCodexCommand(store);
    expectConflict(
      () =>
        store.updateMessageDeliveryStatus(
          skipped.created.session.id,
          skipped.created.memberToken,
          skipped.message.id,
          "completed",
        ),
      "message_delivery_conflict",
    );
  });
});
