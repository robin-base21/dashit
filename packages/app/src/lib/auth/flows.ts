import type { LoginResult } from "./api.ts";
import type { RelayClient } from "./client.ts";
import { enrolCredential, getAssertion } from "./webauthn.ts";

interface RequestOptions {
  challenge: string;
  rpId: string;
  timeout?: number;
  userVerification?: UserVerificationRequirement;
}

export function authenticationOptionsRequest(client: RelayClient): Promise<RequestOptions> {
  return client.post<RequestOptions>("/auth/challenge", undefined, { auth: false });
}

export async function signIn(client: RelayClient, options: RequestOptions): Promise<LoginResult> {
  const assertion = await getAssertion(options);
  return client.post<LoginResult>("/auth/login", { assertion }, { auth: false });
}

/** Step one of registration: ask for a code. Answers the same way for any address. */
export function requestSignupCode(client: RelayClient, email: string): Promise<{ dev_code?: string }> {
  return client.post<{ dev_code?: string }>("/auth/register", { email }, { auth: false });
}

export function verifySignupCode(client: RelayClient, email: string, code: string): Promise<{ reg_token: string }> {
  return client.post<{ reg_token: string }>("/auth/verify", { email, code }, { auth: false });
}

/** Step three: create the passkey, which is also what creates the account. */
export function createAccountWithPasskey(client: RelayClient, regToken: string, label?: string) {
  return enrolCredential(client, regToken, label);
}

/** Adding a passkey to an account that already exists, confirmed by an emailed code. */
export async function enrolAnotherPasskey(client: RelayClient, code: string, label?: string) {
  const { enroll_token } = await client.post<{ enroll_token: string }>("/auth/enroll/verify", { code });
  return enrolCredential(client, enroll_token, label);
}
