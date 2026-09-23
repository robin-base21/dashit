import { createContext } from "svelte";
import type { AccountSummary, CredentialSummary, LoginResult } from "./api.ts";
import { RelayError } from "./api.ts";
import { RelayClient, type TokenStore } from "./client.ts";
import { kvDelete, kvGet, kvSet } from "./store.ts";
import { authenticationOptionsRequest, signIn } from "./flows.ts";

const REFRESH_KEY = "refresh_token";
const ACCOUNT_KEY = "account";

/**
 * Who is signed in, if anyone.
 *
 * Signing in is additive: anonymous mode is a permanent product option (§4.9), so nothing here
 * gates the app. A signed-out user is a normal user, not an error state.
 */
export class Session {
  account = $state.raw<AccountSummary | null>(null);
  credentials = $state.raw<CredentialSummary[]>([]);
  /** The relay could not be reached on the last attempt; the app keeps working regardless. */
  offline = $state(false);
  /** The account was deleted elsewhere and is in its grace period. */
  deleted = $state(false);
  ready = $state(false);

  #access: string | null = null;
  readonly client: RelayClient;

  constructor(baseUrl?: string) {
    const tokens: TokenStore = {
      access: () => this.#access,
      refresh: () => this.#refresh,
      set: async (t) => {
        if (!t) {
          this.#access = null;
          this.#refresh = null;
          await kvDelete(REFRESH_KEY);
          return;
        }
        this.#access = t.access_token;
        this.#refresh = t.refresh_token;
        await kvSet(REFRESH_KEY, t.refresh_token);
      },
    };
    this.client = new RelayClient(tokens, baseUrl);
  }

  #refresh: string | null = null;

  /** The bearer token, for the sync socket: a browser cannot set headers on a WebSocket. */
  accessToken(): string | null {
    return this.#access;
  }

  get signedIn(): boolean {
    return this.account !== null;
  }

  /**
   * Restores a session from the last visit. Any failure leaves the user signed out rather than
   * blocking: the dashboard must open whether or not the relay is up.
   */
  async restore(): Promise<void> {
    try {
      this.#refresh = await kvGet<string>(REFRESH_KEY);
      this.account = await kvGet<AccountSummary>(ACCOUNT_KEY);
      if (this.#refresh) await this.loadAccount();
    } catch {
      // Handled by loadAccount's own error handling; nothing else to do here.
    } finally {
      this.ready = true;
    }
  }

  async loadAccount(): Promise<void> {
    try {
      const res = await this.client.call<{ account: AccountSummary }>("/account");
      this.account = res.account;
      await kvSet(ACCOUNT_KEY, res.account);
      this.deleted = false;
      this.offline = false;
      await this.loadCredentials().catch(() => {});
    } catch (e) {
      if (e instanceof RelayError && e.accountDeleted) {
        this.deleted = true;
        return;
      }
      if (e instanceof RelayError) {
        // A real rejection: the session is gone, so stop claiming to be signed in.
        await this.signOutLocally();
        return;
      }
      this.offline = true;
    }
  }

  /** Signs in with a discoverable passkey — no email typed, nothing revealed. */
  async signInWithPasskey(): Promise<void> {
    const options = await authenticationOptionsRequest(this.client);
    const result = await signIn(this.client, options);
    await this.#adopt(result);
  }

  /** Loaded whenever the session becomes signed in, so views only ever render. */
  async loadCredentials(): Promise<void> {
    const res = await this.client.call<{ credentials: CredentialSummary[] }>("/keys");
    this.credentials = res.credentials;
  }

  async signOut(): Promise<void> {
    try {
      await this.client.post("/auth/logout");
    } catch {
      // A failed logout still signs this device out; the token expires on its own.
    }
    await this.signOutLocally();
  }

  async signOutLocally(): Promise<void> {
    this.#access = null;
    this.#refresh = null;
    this.account = null;
    this.credentials = [];
    await kvDelete(REFRESH_KEY);
    await kvDelete(ACCOUNT_KEY);
  }

  /** Takes the tokens from a completed registration or login. */
  async adoptTokens(result: { access_token: string; refresh_token: string; account: AccountSummary }): Promise<void> {
    await this.#adopt(result as LoginResult);
  }

  async #adopt(result: { access_token: string; refresh_token: string; account: AccountSummary }): Promise<void> {
    this.#access = result.access_token;
    this.#refresh = result.refresh_token;
    this.account = result.account;
    this.deleted = false;
    await kvSet(REFRESH_KEY, result.refresh_token);
    await kvSet(ACCOUNT_KEY, result.account);
    await this.loadCredentials().catch(() => {});
  }
}

export const [getSession, setSession] = createContext<Session>();
