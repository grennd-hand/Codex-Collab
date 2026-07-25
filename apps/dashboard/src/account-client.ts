import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import type {
  AccountProfileResponse,
  RestoreAccountRoomResponse,
} from "@codex-collab/protocol";
import { requestJson } from "./api-client.js";

const jsonHeaders = { "content-type": "application/json" };

export function passkeysAvailable(): boolean {
  return window.isSecureContext && browserSupportsWebAuthn();
}

export async function registerPasskey(
  displayName: string,
): Promise<AccountProfileResponse> {
  const result = await requestJson<{
    options: PublicKeyCredentialCreationOptionsJSON;
  }>("/v1/auth/passkey/registration/options", {
    method: "POST",
    headers: jsonHeaders,
    credentials: "same-origin",
    body: JSON.stringify({ displayName }),
  });
  const response = await startRegistration({ optionsJSON: result.options });
  return requestJson<AccountProfileResponse>(
    "/v1/auth/passkey/registration/verify",
    {
      method: "POST",
      headers: jsonHeaders,
      credentials: "same-origin",
      body: JSON.stringify({ response }),
    },
  );
}

export async function signInWithPasskey(): Promise<AccountProfileResponse> {
  const result = await requestJson<{
    options: PublicKeyCredentialRequestOptionsJSON;
  }>("/v1/auth/passkey/authentication/options", {
    method: "POST",
    headers: jsonHeaders,
    credentials: "same-origin",
    body: "{}",
  });
  const response = await startAuthentication({ optionsJSON: result.options });
  return requestJson<AccountProfileResponse>(
    "/v1/auth/passkey/authentication/verify",
    {
      method: "POST",
      headers: jsonHeaders,
      credentials: "same-origin",
      body: JSON.stringify({ response }),
    },
  );
}

export function loadAccountProfile(): Promise<AccountProfileResponse> {
  return requestJson<AccountProfileResponse>("/v1/account", {
    credentials: "same-origin",
  });
}

export function linkAccountRoom(
  profile: AccountProfileResponse,
  sessionId: string,
  memberToken: string,
): Promise<AccountProfileResponse> {
  return requestJson<AccountProfileResponse>("/v1/account/rooms/link", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      ...jsonHeaders,
      authorization: `Bearer ${memberToken}`,
      "x-codex-csrf": profile.csrfToken,
    },
    body: JSON.stringify({ sessionId }),
  });
}

export function restoreAccountRoom(
  profile: AccountProfileResponse,
  sessionId: string,
  deviceLabel: string,
): Promise<RestoreAccountRoomResponse> {
  return requestJson<RestoreAccountRoomResponse>(
    `/v1/account/rooms/${encodeURIComponent(sessionId)}/restore`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: {
        ...jsonHeaders,
        "x-codex-csrf": profile.csrfToken,
      },
      body: JSON.stringify({ deviceLabel }),
    },
  );
}

export function logoutAccount(profile: AccountProfileResponse): Promise<void> {
  return requestJson<void>("/v1/account/logout", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      ...jsonHeaders,
      "x-codex-csrf": profile.csrfToken,
    },
    body: "{}",
  });
}
