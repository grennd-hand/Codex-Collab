import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { ProtocolError, requiredString } from "@codex-collab/protocol";
import type { RelayRouteContext } from "./route-context.js";
import { requiredObject } from "../http/route-payloads.js";

export async function handleAccountRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  method: string,
  context: RelayRouteContext,
): Promise<boolean> {
  const {
    accountAuth,
    store,
    sendJson,
    readJson,
    passkeyConfig,
    cookieName,
    cookieValue,
    setCookie,
    clearCookie,
    assertAccountRequestOrigin,
    enforceRateLimit,
    optionalConfiguredAccountForWrite,
    requireAccountForWrite,
    requireCsrfToken,
    bearerToken,
    closeAccountSessionSockets,
  } = context;
    if (
      method === "POST" &&
      url.pathname === "/v1/auth/passkey/registration/options"
    ) {
      const config = passkeyConfig(request);
      assertAccountRequestOrigin(request, config);
      enforceRateLimit(request, "registration-options", 10);
      const body = await readJson(request);
      const result = await accountAuth.beginRegistration(
        requiredString(body.displayName, "displayName", 80),
        config,
      );
      sendJson(
        response,
        200,
        { options: result.options },
        {
          "set-cookie": setCookie("ceremony", result.ceremonyToken, config, 300),
        },
      );
      return true;
    }

    if (
      method === "POST" &&
      url.pathname === "/v1/auth/passkey/registration/verify"
    ) {
      const config = passkeyConfig(request);
      assertAccountRequestOrigin(request, config);
      enforceRateLimit(request, "registration-verify", 15);
      const body = await readJson(request);
      const ceremonyToken = cookieValue(
        request,
        cookieName("ceremony", config.secureCookies),
      );
      if (!ceremonyToken) {
        throw new ProtocolError(
          400,
          "passkey_challenge_invalid",
          "Start passkey registration again",
        );
      }
      const result = await accountAuth.finishRegistration(
        ceremonyToken,
        requiredObject(body.response, "response") as unknown as RegistrationResponseJSON,
      );
      const profile = store.getAccountProfile(result.account.id);
      sendJson(
        response,
        201,
        { ...profile, csrfToken: result.csrfToken },
        {
          "set-cookie": [
            setCookie("account", result.accountSessionToken, config, 30 * 24 * 60 * 60),
            clearCookie("ceremony", config),
          ],
        },
      );
      return true;
    }

    if (
      method === "POST" &&
      url.pathname === "/v1/auth/passkey/authentication/options"
    ) {
      const config = passkeyConfig(request);
      assertAccountRequestOrigin(request, config);
      enforceRateLimit(request, "authentication-options", 20);
      await readJson(request);
      const result = await accountAuth.beginAuthentication(config);
      sendJson(
        response,
        200,
        { options: result.options },
        {
          "set-cookie": setCookie("ceremony", result.ceremonyToken, config, 300),
        },
      );
      return true;
    }

    if (
      method === "POST" &&
      url.pathname === "/v1/auth/passkey/authentication/verify"
    ) {
      const config = passkeyConfig(request);
      assertAccountRequestOrigin(request, config);
      enforceRateLimit(request, "authentication-verify", 20);
      const body = await readJson(request);
      const ceremonyToken = cookieValue(
        request,
        cookieName("ceremony", config.secureCookies),
      );
      if (!ceremonyToken) {
        throw new ProtocolError(
          400,
          "passkey_challenge_invalid",
          "Start passkey sign-in again",
        );
      }
      const result = await accountAuth.finishAuthentication(
        ceremonyToken,
        requiredObject(body.response, "response") as unknown as AuthenticationResponseJSON,
      );
      const profile = store.getAccountProfile(result.account.id);
      sendJson(
        response,
        200,
        { ...profile, csrfToken: result.csrfToken },
        {
          "set-cookie": [
            setCookie("account", result.accountSessionToken, config, 30 * 24 * 60 * 60),
            clearCookie("ceremony", config),
          ],
        },
      );
      return true;
    }

    if (method === "GET" && url.pathname === "/v1/account") {
      const config = passkeyConfig(request);
      const accountSessionToken = cookieValue(
        request,
        cookieName("account", config.secureCookies),
      );
      if (!accountSessionToken) {
        throw new ProtocolError(401, "account_required", "Account sign-in is required");
      }
      const refreshed = store.refreshAccountSession(accountSessionToken);
      sendJson(response, 200, {
        ...store.getAccountProfile(refreshed.account.id),
        csrfToken: refreshed.csrfToken,
      });
      return true;
    }

    if (method === "POST" && url.pathname === "/v1/account/logout") {
      const config = passkeyConfig(request);
      await readJson(request);
      const identity = requireAccountForWrite(request, config);
      const accountSessionToken = cookieValue(
        request,
        cookieName("account", config.secureCookies),
      );
      if (accountSessionToken) store.logoutAccount(accountSessionToken);
      closeAccountSessionSockets(identity.accountSessionId);
      sendJson(
        response,
        200,
        { signedOut: true },
        { "set-cookie": clearCookie("account", config) },
      );
      return true;
    }

    if (method === "POST" && url.pathname === "/v1/account/rooms/link") {
      const config = passkeyConfig(request);
      const body = await readJson(request);
      const identity = requireAccountForWrite(request, config);
      const profile = store.bindAccountMembership(
        identity.account.id,
        requiredString(body.sessionId, "sessionId", 120),
        bearerToken(request),
      );
      sendJson(response, 200, { ...profile, csrfToken: requireCsrfToken(request) });
      return true;
    }

    const restoreAccountRoomMatch = url.pathname.match(
      /^\/v1\/account\/rooms\/([^/]+)\/restore$/,
    );
    if (method === "POST" && restoreAccountRoomMatch?.[1]) {
      const config = passkeyConfig(request);
      const body = await readJson(request);
      const identity = requireAccountForWrite(request, config);
      const result = store.restoreAccountRoom(
        identity.account.id,
        restoreAccountRoomMatch[1],
        typeof body.deviceLabel === "string"
          ? body.deviceLabel.trim().slice(0, 120) || "Web device"
          : "Web device",
        identity.accountSessionId,
        identity.expiresAt,
      );
      sendJson(response, 200, result);
      return true;
    }


  return false;
}
