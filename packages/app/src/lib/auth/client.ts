import { RelayError, RELAY_URL } from "./api.ts";

export interface TokenStore {
  access(): string | null;
  refresh(): string | null;
  /** Null clears both, which is what signing out means. */
  set(tokens: { access_token: string; refresh_token: string } | null): Promise<void>;
}

/**
 * Talks to the relay. Access tokens expire every 15 minutes, so a `401` on an authenticated call
 * is ordinary rather than exceptional: refresh once, retry once, and only then surface it.
 */
export class RelayClient {
  #tokens: TokenStore;
  #refreshing: Promise<boolean> | null = null;

  constructor(tokens: TokenStore, readonly baseUrl = RELAY_URL) {
    this.#tokens = tokens;
  }

  async call<T>(path: string, init: RequestInit & { auth?: boolean } = {}): Promise<T> {
    const send = async (): Promise<Response> => {
      const headers = new Headers(init.headers);
      if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
      const token = this.#tokens.access();
      if (init.auth !== false && token) headers.set("authorization", `Bearer ${token}`);
      return fetch(`${this.baseUrl}/api/v1${path}`, { ...init, headers });
    };

    let res = await send();
    if (res.status === 401 && init.auth !== false && this.#tokens.refresh()) {
      if (await this.#refresh()) res = await send();
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new RelayError(res.status, body.error ?? "unknown");
    }
    return (await res.json()) as T;
  }

  post<T>(path: string, body?: unknown, init: RequestInit & { auth?: boolean } = {}): Promise<T> {
    return this.call<T>(path, { ...init, method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
  }

  /** Concurrent calls share one refresh; rotating twice would spend the new token immediately. */
  #refresh(): Promise<boolean> {
    this.#refreshing ??= (async () => {
      try {
        const refresh_token = this.#tokens.refresh();
        if (!refresh_token) return false;
        const res = await fetch(`${this.baseUrl}/api/v1/auth/refresh`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refresh_token }),
        });
        if (!res.ok) {
          await this.#tokens.set(null);
          return false;
        }
        await this.#tokens.set((await res.json()) as { access_token: string; refresh_token: string });
        return true;
      } finally {
        this.#refreshing = null;
      }
    })();
    return this.#refreshing;
  }
}
