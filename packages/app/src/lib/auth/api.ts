/** Shapes the relay returns. Kept apart from the transport so tests can use them freely. */

export interface AccountSummary {
  id: string;
  email: string;
  created_at?: number;
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export interface LoginResult extends TokenPair {
  account: AccountSummary;
  /** Null throughout Phase 2 — there is no DEK yet. Phase 3 fills it in. */
  wrapped_dek: string | null;
  unlock_methods: string[];
}

export interface CredentialSummary {
  id: string;
  label: string;
  prf_capable: boolean;
  created_at: number;
  last_used_at: number | null;
}

export class RelayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`${code} (${status})`);
    this.name = "RelayError";
  }

  /** The account was deleted and is in its grace period: sign-out is not the right response. */
  get accountDeleted(): boolean {
    return this.status === 403 && this.code === "account_deleted";
  }

  get rateLimited(): boolean {
    return this.status === 429;
  }
}

export const RELAY_URL = import.meta.env.VITE_RELAY_URL ?? "http://localhost:3000";
