import type { DashboardRelayOperationV1 } from "./types.js";

type RequestBody = Record<string, unknown>;

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error("请求路径包含无效编码");
  }
}

function parseBody(body: BodyInit | null | undefined): RequestBody {
  if (body === undefined || body === null || body === "") return {};
  if (typeof body !== "string") {
    throw new Error("Dashboard Runtime 只接受 JSON 请求体");
  }
  const parsed = JSON.parse(body) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Dashboard Runtime 请求体必须是 JSON 对象");
  }
  return parsed as RequestBody;
}

function bearerToken(headers?: HeadersInit): string | undefined {
  if (!headers) return undefined;
  const value = new Headers(headers).get("authorization")?.trim();
  if (!value) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value);
  if (!match?.[1]) throw new Error("Dashboard Runtime 只接受 Bearer 认证");
  return match[1];
}

export function parseRelayOperation(
  path: string,
  options: RequestInit = {},
): DashboardRelayOperationV1 {
  const base = "https://dashboard.runtime.invalid";
  const url = new URL(path, base);
  if (url.origin !== base || url.hash) {
    throw new Error("Dashboard Runtime 不接受外部 URL 或 URL fragment");
  }
  const method = (options.method ?? "GET").toUpperCase();
  const authorization = bearerToken(options.headers);
  const body = parseBody(options.body);
  const segments = url.pathname.split("/").filter(Boolean).map(decode);

  if (method === "GET" && url.pathname === "/health") {
    return { operation: "health.get" };
  }
  if (method === "POST" && url.pathname === "/v1/sessions") {
    return { operation: "session.create", input: body as never };
  }
  if (method === "POST" && url.pathname === "/v1/sessions/recover") {
    return { operation: "session.recover", input: body as never };
  }
  if (method === "POST" && url.pathname === "/v1/invites/join") {
    return { operation: "invite.join", input: body as never };
  }
  if (segments[0] !== "v1" || segments[1] !== "sessions" || !segments[2]) {
    throw new Error(`Dashboard Runtime 不支持 ${method} ${url.pathname}`);
  }

  const sessionId = segments[2];
  const authenticated = { authorization, sessionId };
  if (method === "GET" && segments.length === 4 && segments[3] === "me") {
    return { operation: "session.me.get", ...authenticated };
  }
  if (segments.length === 4 && segments[3] === "messages") {
    if (method === "GET") {
      return { operation: "session.messages.list", ...authenticated };
    }
    if (method === "POST") {
      return {
        operation: "session.messages.create",
        ...authenticated,
        input: body as never,
      };
    }
  }
  if (method === "GET" && segments.length === 4 && segments[3] === "members") {
    return { operation: "session.members.list", ...authenticated };
  }
  if (
    method === "POST" &&
    segments.length === 6 &&
    segments[3] === "members" &&
    segments[5] === "approve"
  ) {
    return {
      operation: "session.members.approve",
      ...authenticated,
      memberId: segments[4],
    };
  }
  if (
    method === "PATCH" &&
    segments.length === 6 &&
    segments[3] === "members" &&
    segments[5] === "workspace-file-access"
  ) {
    return {
      operation: "session.members.workspace-access.update",
      ...authenticated,
      memberId: segments[4],
      input: body as never,
    };
  }
  if (method === "POST" && segments.length === 4 && segments[3] === "invites") {
    return {
      operation: "session.invites.create",
      ...authenticated,
      input: body as never,
    };
  }
  if (
    method === "PUT" &&
    segments.length === 4 &&
    segments[3] === "room-status"
  ) {
    return {
      operation: "session.room-status.update",
      ...authenticated,
      input: body as never,
    };
  }
  if (
    method === "POST" &&
    segments.length === 4 &&
    segments[3] === "host-pairings"
  ) {
    return {
      operation: "session.host-pairings.create",
      ...authenticated,
      input: body as never,
    };
  }
  if (
    method === "POST" &&
    segments.length === 4 &&
    segments[3] === "realtime-tickets"
  ) {
    return { operation: "realtime.ticket.create", ...authenticated };
  }
  if (
    method === "GET" &&
    segments.length === 5 &&
    segments[3] === "workspace" &&
    segments[4] === "overview"
  ) {
    return { operation: "workspace.overview.get", ...authenticated };
  }
  if (
    method === "GET" &&
    segments.length === 6 &&
    segments[3] === "workspace" &&
    segments[4] === "history" &&
    segments[5] === "page"
  ) {
    const limit = Number(url.searchParams.get("limit") ?? "40");
    const before = url.searchParams.get("before") ?? undefined;
    return {
      operation: "workspace.history-page.get",
      ...authenticated,
      input: { limit, ...(before ? { before } : {}) },
    };
  }
  if (
    method === "PUT" &&
    segments.length === 5 &&
    segments[3] === "workspace" &&
    segments[4] === "selection"
  ) {
    return {
      operation: "workspace.selection.update",
      ...authenticated,
      input: body as never,
    };
  }
  if (
    method === "GET" &&
    segments.length === 5 &&
    segments[3] === "workspace" &&
    segments[4] === "file"
  ) {
    return {
      operation: "workspace.file.get",
      ...authenticated,
      input: { path: url.searchParams.get("path") ?? "" },
    };
  }
  if (
    segments[3] === "workspace" &&
    segments[4] === "file-operations"
  ) {
    if (method === "POST" && segments.length === 5) {
      return {
        operation: "workspace.file-operation.create",
        ...authenticated,
        input: body as never,
      };
    }
    if (method === "GET" && segments.length === 6) {
      return {
        operation: "workspace.file-operation.get",
        ...authenticated,
        operationId: segments[5],
      };
    }
  }
  throw new Error(`Dashboard Runtime 不支持 ${method} ${url.pathname}`);
}

export function relayOperationRequest(
  operation: DashboardRelayOperationV1,
): { path: string; init: RequestInit } {
  const authorization = "authorization" in operation
    ? operation.authorization
    : undefined;
  const headers: Record<string, string> = {};
  if (authorization) headers.authorization = `Bearer ${authorization}`;
  const json = (input: unknown) => {
    headers["content-type"] = "application/json";
    return JSON.stringify(input);
  };
  const session = "sessionId" in operation
    ? encodeURIComponent(operation.sessionId)
    : "";
  const member = "memberId" in operation
    ? encodeURIComponent(operation.memberId)
    : "";
  switch (operation.operation) {
    case "health.get":
      return { path: "/health", init: { headers } };
    case "session.create":
      return { path: "/v1/sessions", init: { method: "POST", headers, body: json(operation.input) } };
    case "session.recover":
      return { path: "/v1/sessions/recover", init: { method: "POST", headers, body: json(operation.input) } };
    case "invite.join":
      return { path: "/v1/invites/join", init: { method: "POST", headers, body: json(operation.input) } };
    case "session.me.get":
      return { path: `/v1/sessions/${session}/me`, init: { headers } };
    case "session.messages.list":
      return { path: `/v1/sessions/${session}/messages`, init: { headers } };
    case "session.messages.create":
      return { path: `/v1/sessions/${session}/messages`, init: { method: "POST", headers, body: json(operation.input) } };
    case "session.members.list":
      return { path: `/v1/sessions/${session}/members`, init: { headers } };
    case "session.members.approve":
      return { path: `/v1/sessions/${session}/members/${member}/approve`, init: { method: "POST", headers, body: json({}) } };
    case "session.members.workspace-access.update":
      return { path: `/v1/sessions/${session}/members/${member}/workspace-file-access`, init: { method: "PATCH", headers, body: json(operation.input) } };
    case "session.invites.create":
      return { path: `/v1/sessions/${session}/invites`, init: { method: "POST", headers, body: json(operation.input) } };
    case "session.room-status.update":
      return { path: `/v1/sessions/${session}/room-status`, init: { method: "PUT", headers, body: json(operation.input) } };
    case "session.host-pairings.create":
      return { path: `/v1/sessions/${session}/host-pairings`, init: { method: "POST", headers, body: json(operation.input) } };
    case "workspace.overview.get":
      return { path: `/v1/sessions/${session}/workspace/overview`, init: { headers } };
    case "workspace.history-page.get": {
      const before = operation.input.before
        ? `&before=${encodeURIComponent(operation.input.before)}`
        : "";
      return { path: `/v1/sessions/${session}/workspace/history/page?limit=${operation.input.limit}${before}`, init: { headers } };
    }
    case "workspace.selection.update":
      return { path: `/v1/sessions/${session}/workspace/selection`, init: { method: "PUT", headers, body: json(operation.input) } };
    case "workspace.file.get": {
      return { path: `/v1/sessions/${session}/workspace/file?path=${encodeURIComponent(operation.input.path)}`, init: { headers } };
    }
    case "workspace.file-operation.create":
      return { path: `/v1/sessions/${session}/workspace/file-operations`, init: { method: "POST", headers, body: json(operation.input) } };
    case "workspace.file-operation.get":
      return { path: `/v1/sessions/${session}/workspace/file-operations/${encodeURIComponent(operation.operationId)}`, init: { headers } };
    case "realtime.ticket.create":
      return { path: `/v1/sessions/${session}/realtime-tickets`, init: { method: "POST", headers, body: json({}) } };
  }
}
