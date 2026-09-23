import type { RelayClient } from "./client.ts";

/**
 * WebAuthn ceremonies. The PRF extension is requested so Phase 3 can wrap the data key with it —
 * this phase records only *whether* the authenticator offers it. The PRF output itself is key
 * material and never leaves the device.
 */

/** Fixed app-wide PRF salt (ARCHITECTURE.md §4.1); the PRF output is already unique per credential. */
export const APP_PRF_SALT = new TextEncoder().encode("dashit/prf/v1").buffer;

export function isSupported(): boolean {
  return typeof PublicKeyCredential !== "undefined";
}

export async function hasPlatformAuthenticator(): Promise<boolean> {
  if (!isSupported()) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

function b64url(buf: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Built over an explicit ArrayBuffer: WebAuthn's DOM types require exactly that, not ArrayBufferLike. */
function fromB64url(value: string): Uint8Array<ArrayBuffer> {
  const s = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

type CreationOptions = PublicKeyCredentialCreationOptionsJSONish;
interface PublicKeyCredentialCreationOptionsJSONish {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { type: "public-key"; alg: number }[];
  timeout?: number;
  excludeCredentials?: { id: string; type: "public-key"; transports?: string[] }[];
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  attestation?: AttestationConveyancePreference;
}

interface RequestOptionsJSONish {
  challenge: string;
  rpId: string;
  timeout?: number;
  userVerification?: UserVerificationRequirement;
  allowCredentials?: { id: string; type: "public-key"; transports?: string[] }[];
}

export interface NewCredential {
  credential: unknown;
  /** Whether the authenticator supports PRF. The output is deliberately not included. */
  prf_capable: boolean;
}

/**
 * Creates a credential. §4.3's fallback: some platforms report `prf.enabled` without returning
 * results from `create()`, and need one follow-up `get()` to produce them — so capability is
 * established from either signal.
 */
export async function createCredential(options: CreationOptions): Promise<NewCredential> {
  const publicKey: PublicKeyCredentialCreationOptions = {
    challenge: fromB64url(options.challenge),
    rp: options.rp,
    user: {
      id: fromB64url(options.user.id),
      name: options.user.name,
      displayName: options.user.displayName,
    },
    pubKeyCredParams: options.pubKeyCredParams,
    timeout: options.timeout,
    excludeCredentials: options.excludeCredentials?.map((c) => ({
      id: fromB64url(c.id),
      type: "public-key",
      transports: c.transports as AuthenticatorTransport[] | undefined,
    })),
    authenticatorSelection: options.authenticatorSelection,
    attestation: options.attestation,
    extensions: { prf: { eval: { first: APP_PRF_SALT } } } as AuthenticationExtensionsClientInputs,
  };

  const cred = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
  if (!cred) throw new Error("no credential created");

  const ext = cred.getClientExtensionResults() as { prf?: { enabled?: boolean; results?: unknown } };
  return { credential: toRegistrationJSON(cred), prf_capable: ext.prf?.enabled === true || !!ext.prf?.results };
}

export async function getAssertion(options: RequestOptionsJSONish): Promise<unknown> {
  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge: fromB64url(options.challenge),
    rpId: options.rpId,
    timeout: options.timeout,
    userVerification: options.userVerification,
    // No allowCredentials: the passkey is discoverable, so login needs no email.
    allowCredentials: options.allowCredentials?.map((c) => ({
      id: fromB64url(c.id),
      type: "public-key",
      transports: c.transports as AuthenticatorTransport[] | undefined,
    })),
    extensions: { prf: { eval: { first: APP_PRF_SALT } } } as AuthenticationExtensionsClientInputs,
  };
  const cred = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (!cred) throw new Error("no assertion");
  return toAuthenticationJSON(cred);
}

function toRegistrationJSON(cred: PublicKeyCredential) {
  const r = cred.response as AuthenticatorAttestationResponse;
  return {
    id: cred.id,
    rawId: b64url(cred.rawId),
    type: cred.type,
    clientExtensionResults: {},
    response: {
      clientDataJSON: b64url(r.clientDataJSON),
      attestationObject: b64url(r.attestationObject),
      transports: r.getTransports?.() ?? [],
    },
  };
}

function toAuthenticationJSON(cred: PublicKeyCredential) {
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: b64url(cred.rawId),
    type: cred.type,
    clientExtensionResults: {},
    response: {
      clientDataJSON: b64url(r.clientDataJSON),
      authenticatorData: b64url(r.authenticatorData),
      signature: b64url(r.signature),
      userHandle: r.userHandle ? b64url(r.userHandle) : undefined,
    },
  };
}

/** Fetches creation options for a grant token and completes the ceremony. */
export async function enrolCredential(client: RelayClient, token: string, label?: string) {
  const options = await client.post<CreationOptions>("/keys/options", { token }, { auth: false });
  const { credential, prf_capable } = await createCredential(options);
  return client.post<{ access_token: string; refresh_token: string; account: { id: string; email: string } }>(
    "/keys",
    // No wrapped_dek: there is no data key until Phase 3.
    { token, credential, prf_capable, label, wrapped_dek: null },
    { auth: false },
  );
}
