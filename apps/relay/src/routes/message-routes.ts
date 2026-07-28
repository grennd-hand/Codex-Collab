import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ProtocolError,
  requiredString,
  type MessageDeliveryStatus,
  type MessageKind,
} from "@codex-collab/protocol";
import {
  parseMessageAttachments,
} from "../http/route-payloads.js";
import {
  parseCodexOptions,
  validateCodexPromptCapabilities,
} from "../codex-options.js";
import type { RelayRouteContext } from "./route-context.js";

export async function handleMessageRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  method: string,
  context: RelayRouteContext,
): Promise<boolean> {
  const {
    store,
    sendJson,
    sendAttachment,
    readJson,
    bearerToken,
    enforceRateLimit,
    broadcast,
  } = context;
    const messagesMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/messages$/);
    if (messagesMatch?.[1] && method === "GET") {
      const after = url.searchParams.get("after") ?? undefined;
      sendJson(response, 200, {
        messages: store.listMessages(messagesMatch[1], bearerToken(request), after),
      });
      return true;
    }
    if (messagesMatch?.[1] && method === "POST") {
      enforceRateLimit(request, "message-create", 120, 60_000);
      const body = await readJson(request, 9_000_000);
      const kind = body.kind ?? "chat";
      if (kind !== "chat" && kind !== "codex_prompt" && kind !== "codex_stop") {
        throw new ProtocolError(
          400,
          "invalid_request",
          "kind must be chat, codex_prompt or codex_stop",
        );
      }
      const attachments = parseMessageAttachments(body.attachments);
      if (kind === "codex_stop" && attachments.length > 0) {
        throw new ProtocolError(
          400,
          "invalid_request",
          "attachments are supported only for chat and Codex prompts",
        );
      }
      const codexOptions =
        kind === "codex_prompt" ? parseCodexOptions(body.codexOptions) : null;
      const expectedWorkspaceThreadId =
        kind === "codex_prompt"
          ? requiredString(
              body.expectedWorkspaceThreadId,
              "expectedWorkspaceThreadId",
              160,
            )
          : undefined;
      if (codexOptions) {
        validateCodexPromptCapabilities(codexOptions, attachments);
      }
      const message = store.addMessage(
        messagesMatch[1],
        bearerToken(request),
        kind as MessageKind,
        requiredString(body.body, "body", 50_000),
        {
          attachments,
          codexOptions,
          ...(expectedWorkspaceThreadId === undefined
            ? {}
            : { expectedWorkspaceThreadId }),
        },
      );
      broadcast(messagesMatch[1], "message.created", message);
      sendJson(response, 201, { message });
      return true;
    }

    const attachmentMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/messages\/([^/]+)\/attachments\/([^/]+)$/,
    );
    if (
      method === "GET" &&
      attachmentMatch?.[1] &&
      attachmentMatch[2] &&
      attachmentMatch[3]
    ) {
      sendAttachment(
        response,
        store.getMessageAttachment(
          attachmentMatch[1],
          bearerToken(request),
          attachmentMatch[2],
          attachmentMatch[3],
        ),
      );
      return true;
    }

    const messageStatusMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/messages\/([^/]+)\/status$/,
    );
    const hostMessageStatusMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/host\/messages\/([^/]+)\/status$/,
    );
    if (method === "PATCH" && hostMessageStatusMatch?.[1] && hostMessageStatusMatch[2]) {
      const body = await readJson(request);
      if (
        body.status !== "queued" &&
        body.status !== "submitted" &&
        body.status !== "completed" &&
        body.status !== "failed"
      ) {
        throw new ProtocolError(400, "invalid_request", "status is invalid");
      }
      const codexTurnId =
        body.codexTurnId === undefined || body.codexTurnId === null
          ? null
          : requiredString(body.codexTurnId, "codexTurnId", 160);
      const message = store.updateMessageDeliveryStatusFromHost(
        hostMessageStatusMatch[1],
        bearerToken(request),
        hostMessageStatusMatch[2],
        body.status as MessageDeliveryStatus,
        codexTurnId,
      );
      broadcast(hostMessageStatusMatch[1], "message.created", message);
      sendJson(response, 200, { message });
      return true;
    }
    if (method === "PATCH" && messageStatusMatch?.[1] && messageStatusMatch[2]) {
      const body = await readJson(request);
      if (
        body.status !== "queued" &&
        body.status !== "submitted" &&
        body.status !== "completed" &&
        body.status !== "failed"
      ) {
        throw new ProtocolError(400, "invalid_request", "status is invalid");
      }
      const codexTurnId =
        body.codexTurnId === undefined || body.codexTurnId === null
          ? null
          : requiredString(body.codexTurnId, "codexTurnId", 160);
      const message = store.updateMessageDeliveryStatus(
        messageStatusMatch[1],
        bearerToken(request),
        messageStatusMatch[2],
        body.status as MessageDeliveryStatus,
        codexTurnId,
      );
      broadcast(messageStatusMatch[1], "message.created", message);
      sendJson(response, 200, { message });
      return true;
    }


  return false;
}
