import { chunkRows, SCHEMA_VERSION, SYNCED_TABLES, type Changeset, type PullResponse, type PushResponse, type SnapshotBody } from "shared";
import { createContext } from "svelte";
import type { Db } from "$lib/db/client.svelte";
import { RelayError } from "$lib/auth/api";
import type { RelayClient } from "$lib/auth/client";
import { decodeChangeset, encodeChangeset, fromBase64, rowSize, toBase64 } from "./codec.ts";

/**
 * Stage 2 sends plaintext (§10). The flag exists so this cannot reach production by accident:
 * Phase 3 deletes it rather than flipping its default.
 */
export const PLAINTEXT_SYNC = import.meta.env.VITE_DASHIT_PLAINTEXT_SYNC === "1";

const PUSH_DEBOUNCE_MS = 500;
const POLL_INTERVAL_MS = 60_000;
/** §3.5: snapshot once this far past the last one. */
const SNAPSHOT_EVERY = 500;

export type SyncStatus = "off" | "idle" | "syncing" | "error" | "update_required";

export class SyncEngine {
  status = $state<SyncStatus>("off");
  lastSyncAt = $state<number | null>(null);
  lastError = $state<string | null>(null);

  #db: Db;
  #client: RelayClient;
  #siteId: () => string;
  #relayUrl: string;
  #getToken: () => string | null;

  #stop: (() => void)[] = [];
  #socket: WebSocket | null = null;
  #pushTimer: ReturnType<typeof setTimeout> | null = null;
  #pollTimer: ReturnType<typeof setInterval> | null = null;
  #running = false;
  #queued = false;

  constructor(opts: { db: Db; client: RelayClient; siteId: () => string; relayUrl: string; token: () => string | null }) {
    this.#db = opts.db;
    this.#client = opts.client;
    this.#siteId = opts.siteId;
    this.#relayUrl = opts.relayUrl;
    this.#getToken = opts.token;
  }

  start(): void {
    if (!PLAINTEXT_SYNC) {
      // Refusing loudly beats syncing plaintext because a flag was forgotten.
      this.status = "off";
      this.lastError = "Sync is disabled in this build.";
      return;
    }
    this.status = "idle";
    // Only synced tables: a polling datasource writes its cache constantly, and waking the
    // pusher for rows that never leave the device would be pure noise.
    this.#stop.push(this.#db.onChange([...SYNCED_TABLES], () => this.schedulePush()));
    this.#pollTimer = setInterval(() => void this.syncNow(), POLL_INTERVAL_MS);
    this.#openSocket();
    void this.syncNow();
  }

  stop(): void {
    for (const s of this.#stop) s();
    this.#stop = [];
    if (this.#pushTimer) clearTimeout(this.#pushTimer);
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    this.#socket?.close();
    this.#socket = null;
    this.status = "off";
  }

  schedulePush(): void {
    if (this.#pushTimer) clearTimeout(this.#pushTimer);
    this.#pushTimer = setTimeout(() => void this.syncNow(), PUSH_DEBOUNCE_MS);
  }

  /** One full round: push what is local, then pull what is not. Never runs twice at once. */
  async syncNow(): Promise<void> {
    if (this.status === "off" || this.status === "update_required") return;
    if (this.#running) {
      this.#queued = true;
      return;
    }
    this.#running = true;
    this.status = "syncing";
    try {
      await this.push();
      await this.pull();
      this.lastError = null;
      this.lastSyncAt = Date.now();
      this.status = "idle";
      await this.#db.call("markSyncResult", null);
    } catch (e) {
      if (e instanceof RelayError && e.code === "schema_too_new") {
        this.status = "update_required";
        this.lastError = "This device is running an older version. Update to keep syncing.";
      } else {
        this.status = "error";
        this.lastError = e instanceof Error ? e.message : String(e);
      }
      await this.#db.call("markSyncResult", this.lastError).catch(() => {});
    } finally {
      this.#running = false;
      if (this.#queued) {
        this.#queued = false;
        void this.syncNow();
      }
    }
  }

  async push(): Promise<void> {
    const pending = await this.#db.call("pendingChanges");
    if (pending.rows.length === 0) return;

    // One envelope per chunk, in order: a site's envelopes must apply in db_version order.
    let from = pending.from;
    for (const chunk of chunkRows(pending.rows, rowSize)) {
      const to = chunk.reduce((max, r) => (r.db_version > max ? r.db_version : max), from);
      await this.#client.post<PushResponse>("/sync/push", {
        v: 1,
        site_id: this.#siteId(),
        schema_version: pending.schema_version,
        from,
        to,
        payload: toBase64(encodeChangeset(chunk)),
      });
      await this.#db.call("markPushed", to);
      from = to;
    }
  }

  async pull(): Promise<void> {
    const state = await this.#db.call("getSyncState");
    let since = state.last_pulled_seq;

    for (;;) {
      let res: PullResponse;
      try {
        res = await this.#client.call<PullResponse>(
          `/sync/pull?since=${since}&limit=100&site_id=${encodeURIComponent(this.#siteId())}`,
        );
      } catch (e) {
        // Everything this device still needed has been pruned; only a snapshot can catch it up.
        if (e instanceof RelayError && e.status === 410) {
          await this.bootstrapFromSnapshot();
          return;
        }
        throw e;
      }
      if (res.envelopes.length === 0) break;

      // An envelope from a newer schema cannot be applied safely; stop pulling but keep pushing,
      // since this device's own changes are still valid under the newer schema (§3.6).
      const tooNew = res.envelopes.find((e) => e.schema_version > SCHEMA_VERSION);
      if (tooNew) throw new RelayError(409, "schema_too_new");

      await this.#db.call(
        "applyPulled",
        res.envelopes.map((e) => decodeChangeset(fromBase64(e.payload))),
        res.next,
      );
      since = res.next;
      await this.maybeSnapshot(since);
      if (res.envelopes.length < 100) break;
    }
  }

  /** Replaces local state from the relay's snapshot, then resumes from where it ends. */
  async bootstrapFromSnapshot(): Promise<void> {
    const snap = await this.#client.call<SnapshotBody>("/sync/snapshot");
    const rows = decodeChangeset(fromBase64(snap.payload)) as Changeset;
    await this.#db.call("adoptSnapshot", rows, snap.covers_seq);
  }

  /** §3.5: any device may snapshot once it is far enough past the last one. */
  async maybeSnapshot(seq: number): Promise<void> {
    const state = await this.#db.call("getSyncState");
    if (seq - state.last_snapshot_seq < SNAPSHOT_EVERY) return;
    const rows = await this.#db.call("fullChangeset");
    await this.#client.post("/sync/snapshot", {
      covers_seq: seq,
      schema_version: SCHEMA_VERSION,
      payload: toBase64(encodeChangeset(rows)),
    });
    await this.#db.call("markSnapshot", seq);
  }

  /**
   * The live nudge. Payload-free — it only says a new seq exists, so the pull below is what
   * actually moves data. The poll stays running, so a dropped socket degrades rather than stops.
   */
  #openSocket(): void {
    const token = this.#getToken();
    if (!token) return;
    try {
      const url = `${this.#relayUrl.replace(/^http/, "ws")}/api/v1/subscribe?site_id=${encodeURIComponent(this.#siteId())}`;
      const socket = new WebSocket(url, ["bearer", token]);
      socket.onmessage = () => void this.syncNow();
      socket.onclose = () => {
        if (this.#socket === socket) this.#socket = null;
      };
      this.#socket = socket;
    } catch {
      // Poll-only is a working degradation, not a failure worth surfacing.
    }
  }
}

export const [getSync, setSync] = createContext<SyncEngine>();
