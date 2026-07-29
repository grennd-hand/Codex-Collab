import { randomUUID } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { ProtocolError, type Account } from "@codex-collab/protocol";
import { SessionStore } from "../application/session-store.js";

export interface PasskeyRequestConfig {
  origin: string;
  rpId: string;
  rpName: string;
  secureCookies: boolean;
}

export interface ResolvePasskeyConfigInput {
  configuredOrigin?: string;
  configuredRpId?: string;
  rpName?: string;
  requestHost?: string;
}

function loopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function resolvePasskeyConfig(
  input: ResolvePasskeyConfigInput,
): PasskeyRequestConfig {
  let originUrl: URL;
  if (input.configuredOrigin) {
    try {
      originUrl = new URL(input.configuredOrigin);
    } catch {
      throw new ProtocolError(
        503,
        "passkey_not_configured",
        "Passkey origin configuration is invalid",
      );
    }
    if (
      originUrl.username ||
      originUrl.password ||
      originUrl.search ||
      originUrl.hash ||
      (originUrl.pathname !== "/" && originUrl.pathname !== "")
    ) {
      throw new ProtocolError(
        503,
        "passkey_not_configured",
        "Passkey origin must not include credentials, a path, query, or fragment",
      );
    }
  } else {
    const host = input.requestHost?.trim();
    if (!host) {
      throw new ProtocolError(
        503,
        "passkey_not_configured",
        "Passkey origin must be configured",
      );
    }
    try {
      originUrl = new URL(`http://${host}`);
    } catch {
      throw new ProtocolError(
        503,
        "passkey_not_configured",
        "Passkey origin must be configured",
      );
    }
    if (!loopbackHost(originUrl.hostname)) {
      throw new ProtocolError(
        503,
        "passkey_not_configured",
        "Passkey origin must be configured for non-loopback access",
      );
    }
  }

  const isLoopback = loopbackHost(originUrl.hostname);
  if (originUrl.protocol !== "https:" && !(isLoopback && originUrl.protocol === "http:")) {
    throw new ProtocolError(
      503,
      "passkey_not_configured",
      "Passkeys require HTTPS outside localhost",
    );
  }
  const rpId = input.configuredRpId?.trim() || originUrl.hostname;
  if (rpId !== originUrl.hostname) {
    throw new ProtocolError(
      503,
      "passkey_not_configured",
      "Passkey RP ID must exactly match the configured origin hostname",
    );
  }
  return {
    origin: originUrl.origin,
    rpId,
    rpName: input.rpName?.trim() || "Codex Collab",
    secureCookies: originUrl.protocol === "https:",
  };
}

function verificationFailure(error: unknown): ProtocolError {
  if (error instanceof ProtocolError) return error;
  return new ProtocolError(
    400,
    "passkey_verification_failed",
    "The passkey response could not be verified",
  );
}

export class AccountAuthService {
  constructor(private readonly store: SessionStore) {}

  async beginRegistration(
    displayName: string,
    config: PasskeyRequestConfig,
  ): Promise<{
    ceremonyToken: string;
    options: PublicKeyCredentialCreationOptionsJSON;
  }> {
    const accountId = randomUUID();
    const options = await generateRegistrationOptions({
      rpName: config.rpName,
      rpID: config.rpId,
      userID: Buffer.from(accountId, "utf8"),
      userName: `codex-${accountId.slice(0, 12)}`,
      userDisplayName: displayName,
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
    });
    const ceremonyToken = this.store.createAccountChallenge({
      kind: "registration",
      challenge: options.challenge,
      accountId,
      displayName,
      expectedOrigin: config.origin,
      rpId: config.rpId,
    });
    return { ceremonyToken, options };
  }

  async finishRegistration(
    ceremonyToken: string,
    response: RegistrationResponseJSON,
  ): Promise<{
    account: Account;
    accountSessionToken: string;
    csrfToken: string;
  }> {
    const challenge = this.store.consumeAccountChallenge(
      ceremonyToken,
      "registration",
    );
    if (!challenge.accountId || !challenge.displayName) {
      throw new ProtocolError(
        400,
        "passkey_challenge_invalid",
        "The registration request is incomplete",
      );
    }
    try {
      const verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: challenge.expectedOrigin,
        expectedRPID: challenge.rpId,
        requireUserVerification: true,
      });
      if (!verification.verified) throw verificationFailure(null);
      const info = verification.registrationInfo;
      return this.store.registerAccount({
        accountId: challenge.accountId,
        displayName: challenge.displayName,
        credentialId: info.credential.id,
        publicKey: info.credential.publicKey,
        counter: info.credential.counter,
        transports: info.credential.transports ?? response.response.transports ?? [],
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
      });
    } catch (error) {
      throw verificationFailure(error);
    }
  }

  async beginAuthentication(config: PasskeyRequestConfig): Promise<{
    ceremonyToken: string;
    options: PublicKeyCredentialRequestOptionsJSON;
  }> {
    const options = await generateAuthenticationOptions({
      rpID: config.rpId,
      userVerification: "required",
    });
    const ceremonyToken = this.store.createAccountChallenge({
      kind: "authentication",
      challenge: options.challenge,
      expectedOrigin: config.origin,
      rpId: config.rpId,
    });
    return { ceremonyToken, options };
  }

  async finishAuthentication(
    ceremonyToken: string,
    response: AuthenticationResponseJSON,
  ): Promise<{
    account: Account;
    accountSessionToken: string;
    csrfToken: string;
  }> {
    const challenge = this.store.consumeAccountChallenge(
      ceremonyToken,
      "authentication",
    );
    try {
      const stored = this.store.getAccountCredential(response.id);
      const userHandle = response.response.userHandle;
      if (!userHandle || isoBase64URL.toUTF8String(userHandle) !== stored.accountId) {
        throw new ProtocolError(
          400,
          "passkey_account_mismatch",
          "The passkey account could not be verified",
        );
      }
      const verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: challenge.expectedOrigin,
        expectedRPID: challenge.rpId,
        requireUserVerification: true,
        credential: {
          id: stored.id,
          publicKey: new Uint8Array(stored.publicKey) as Uint8Array<ArrayBuffer>,
          counter: stored.counter,
          transports: stored.transports as AuthenticatorTransportFuture[],
        },
      });
      if (!verification.verified) throw verificationFailure(null);
      return this.store.authenticateAccountCredential(
        stored.id,
        stored.counter,
        verification.authenticationInfo.newCounter,
        verification.authenticationInfo.credentialDeviceType,
        verification.authenticationInfo.credentialBackedUp,
      );
    } catch (error) {
      throw verificationFailure(error);
    }
  }
}
