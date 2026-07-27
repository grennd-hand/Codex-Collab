import type { IncomingMessage, ServerResponse } from "node:http";
import {
  optionalInteger,
  ProtocolError,
  requiredString,
  type RoomStatus,
} from "@codex-collab/protocol";
import { buildInviteLink, resolveInviteOrigin } from "../invite-link.js";
import type { RelayRouteContext } from "./route-context.js";

export async function handleSessionRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  method: string,
  context: RelayRouteContext,
): Promise<boolean> {
  const {
    store,
    realtimeTickets,
    configuredPublicUrl,
    host,
    port,
    trustProxy,
    sendJson,
    readJson,
    bearerToken,
    prefersMinimalResponse,
    optionalConfiguredAccountForWrite,
    enforceRateLimit,
    broadcast,
  } = context;
    if (method === "POST" && url.pathname === "/v1/sessions") {
      enforceRateLimit(request, "session-create", 20, 15 * 60_000);
      const body = await readJson(request);
      const account = optionalConfiguredAccountForWrite(request);
      const result = store.createSession(
        requiredString(body.name, "name", 120),
        requiredString(body.ownerDisplayName, "ownerDisplayName", 80),
        typeof body.deviceLabel === "string" ? body.deviceLabel.slice(0, 120) : undefined,
        account ?? undefined,
      );
      sendJson(response, 201, result);
      return true;
    }

    if (method === "POST" && url.pathname === "/v1/sessions/recover") {
      enforceRateLimit(request, "session-recover", 10, 15 * 60_000);
      const body = await readJson(request);
      const result = store.recoverSession(
        requiredString(body.sessionId, "sessionId", 100),
        requiredString(body.recoveryKey, "recoveryKey", 200),
        typeof body.deviceLabel === "string" ? body.deviceLabel.slice(0, 120) : undefined,
      );
      sendJson(response, 200, result);
      return true;
    }

    if (method === "POST" && url.pathname === "/v1/invites/join") {
      enforceRateLimit(request, "invite-join", 30);
      const body = await readJson(request);
      const account = optionalConfiguredAccountForWrite(request);
      const result = store.joinInvite(
        requiredString(body.inviteToken, "inviteToken", 200),
        requiredString(body.displayName, "displayName", 80),
        typeof body.deviceLabel === "string" ? body.deviceLabel.slice(0, 120) : undefined,
        account ?? undefined,
      );
      broadcast(result.session.id, "member.updated", result.member);
      sendJson(response, 201, result);
      return true;
    }

    if (method === "POST" && url.pathname === "/v1/host-pairings/claim") {
      enforceRateLimit(request, "host-pairing-claim", 30);
      const body = await readJson(request);
      const result = store.claimHostPairing(
        requiredString(body.pairingToken, "pairingToken", 200),
        requiredString(body.deviceLabel, "deviceLabel", 120),
        requiredString(body.rootLabel, "rootLabel", 200),
      );
      broadcast(result.session.id, "workspace.updated", { hostConnected: true });
      sendJson(response, 201, result);
      return true;
    }

    const inviteMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/invites$/);
    if (method === "POST" && inviteMatch?.[1]) {
      const sessionId = inviteMatch[1];
      const body = await readJson(request);
      const expiresInMinutes = optionalInteger(
        body.expiresInMinutes,
        60,
        "expiresInMinutes",
        5,
        10_080,
      );
      const maxUses = optionalInteger(body.maxUses, 1, "maxUses", 1, 20);
      const invite = store.createInvite(
        sessionId,
        bearerToken(request),
        expiresInMinutes,
        maxUses,
      );
      sendJson(response, 201, {
        sessionId,
        ...invite,
        inviteLink: buildInviteLink(
          resolveInviteOrigin({
            ...(configuredPublicUrl ? { configuredPublicUrl } : {}),
            ...(typeof request.headers["x-forwarded-proto"] === "string"
              ? { forwardedProto: request.headers["x-forwarded-proto"] }
              : {}),
            ...(request.headers.host ? { hostHeader: request.headers.host } : {}),
            listenHost: host,
            listenPort: port,
            trustProxy,
          }),
          invite.inviteToken,
        ),
      });
      return true;
    }

    const pairingMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/host-pairings$/);
    if (method === "POST" && pairingMatch?.[1]) {
      const body = await readJson(request);
      const expiresInMinutes = optionalInteger(
        body.expiresInMinutes,
        10,
        "expiresInMinutes",
        2,
        30,
      );
      const pairing = store.createHostPairing(
        pairingMatch[1],
        bearerToken(request),
        expiresInMinutes,
      );
      sendJson(response, 201, { sessionId: pairingMatch[1], ...pairing });
      return true;
    }

    const roomStatusMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/room-status$/,
    );
    if (method === "PUT" && roomStatusMatch?.[1]) {
      const body = await readJson(request);
      if (body.roomStatus !== "open" && body.roomStatus !== "closed") {
        throw new ProtocolError(
          400,
          "invalid_request",
          "roomStatus must be open or closed",
        );
      }
      const session = store.updateRoomStatus(
        roomStatusMatch[1],
        bearerToken(request),
        body.roomStatus as RoomStatus,
      );
      broadcast(roomStatusMatch[1], "session.updated", session);
      sendJson(response, 200, { session });
      return true;
    }

    const meMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/me$/);
    if (method === "GET" && meMatch?.[1]) {
      sendJson(response, 200, {
        member: store.getCurrentMember(meMatch[1], bearerToken(request)),
        session: store.getSession(meMatch[1]),
      });
      return true;
    }

    const realtimeTicketMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/realtime-tickets$/,
    );
    if (method === "POST" && realtimeTicketMatch?.[1]) {
      enforceRateLimit(request, "realtime-ticket", 120, 60_000);
      await readJson(request, 4_096);
      const sessionId = realtimeTicketMatch[1];
      const memberToken = bearerToken(request);
      const member = store.authenticateRealtime(sessionId, memberToken);
      const ticket = realtimeTickets.issue({
        sessionId,
        member,
        session: store.getSession(sessionId),
        accountSessionId: store.accountSessionForMemberToken(sessionId, memberToken),
      });
      sendJson(response, 201, ticket);
      return true;
    }

    const membersMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/members$/);
    if (method === "GET" && membersMatch?.[1]) {
      sendJson(response, 200, {
        members: store.listMembers(membersMatch[1], bearerToken(request)),
      });
      return true;
    }

    const approveMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/members\/([^/]+)\/approve$/,
    );
    if (method === "POST" && approveMatch?.[1] && approveMatch[2]) {
      const member = store.approveMember(
        approveMatch[1],
        bearerToken(request),
        approveMatch[2],
      );
      broadcast(approveMatch[1], "member.updated", member);
      sendJson(response, 200, { member });
      return true;
    }

    const workspaceAccessMatch = url.pathname.match(
      /^\/v1\/sessions\/([^/]+)\/members\/([^/]+)\/workspace-file-access$/,
    );
    if (
      method === "PATCH" &&
      workspaceAccessMatch?.[1] &&
      workspaceAccessMatch[2]
    ) {
      const body = await readJson(request);
      if (
        body.workspaceFileAccess !== "read-only" &&
        body.workspaceFileAccess !== "workspace-write"
      ) {
        throw new ProtocolError(
          400,
          "invalid_request",
          "workspaceFileAccess must be read-only or workspace-write",
        );
      }
      const member = store.updateMemberWorkspaceFileAccess(
        workspaceAccessMatch[1],
        bearerToken(request),
        workspaceAccessMatch[2],
        body.workspaceFileAccess,
      );
      broadcast(workspaceAccessMatch[1], "member.updated", member);
      sendJson(response, 200, { member });
      return true;
    }


  return false;
}
