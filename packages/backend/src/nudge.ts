/**
 * Live "there is something to pull" fan-out (§3.4).
 *
 * Payload-free by design: the socket carries a `seq` and nothing else, so the relay never becomes
 * a delivery path for content. Clients pull over HTTP as usual; this only removes the wait.
 *
 * In-memory, which is the right scope for a single-instance relay. A multi-instance deployment
 * would need the publish to cross instances — noted rather than built.
 */
export interface NudgeSocket {
  send(data: string): void;
  /** The site that opened it, so a push is not announced back to its own author. */
  siteId: string;
}

export class Nudge {
  #byAccount = new Map<string, Set<NudgeSocket>>();

  subscribe(accountId: string, socket: NudgeSocket): () => void {
    const set = this.#byAccount.get(accountId) ?? new Set<NudgeSocket>();
    set.add(socket);
    this.#byAccount.set(accountId, set);
    return () => {
      set.delete(socket);
      if (set.size === 0) this.#byAccount.delete(accountId);
    };
  }

  publish(accountId: string, seq: number, fromSiteId: string): void {
    const set = this.#byAccount.get(accountId);
    if (!set) return;
    const message = JSON.stringify({ seq });
    for (const socket of set) {
      if (socket.siteId === fromSiteId) continue;
      try {
        socket.send(message);
      } catch {
        // A dead socket is dropped on its own close event; a failed send is not worth propagating.
      }
    }
  }

  /** Sockets currently attached, for tests and diagnostics. */
  count(accountId: string): number {
    return this.#byAccount.get(accountId)?.size ?? 0;
  }
}
