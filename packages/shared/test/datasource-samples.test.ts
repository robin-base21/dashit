import { beforeEach, describe, expect, test } from "bun:test";
import type { LocalStore } from "../src/local-store.ts";
import { migrate } from "../src/migrate.ts";
import {
  createDatasource,
  deleteDatasource,
  listDatasourceSamples,
  recordDatasourceFetch,
  updateDatasource,
} from "../src/repo/datasources.ts";
import { DEFAULT_TRACK_LIMIT, rowsForMerge, shapeSample, trackLimit } from "../src/track.ts";
import type { TrackMode } from "../src/types.ts";
import { BunSqliteStore } from "./bun-sqlite-store.ts";

let store: LocalStore;

beforeEach(async () => {
  store = new BunSqliteStore();
  await migrate(store, { crr: false });
});

async function tracked(mode: TrackMode, extra: { track_key?: string; track_limit?: number } = {}): Promise<string> {
  return createDatasource(store, {
    kind: "external",
    name: `${mode} source`,
    url: "https://example.invalid/x",
    fetch_mode: "poll",
    track_mode: mode,
    ...extra,
  });
}

async function samplesOf(id: string): Promise<Record<string, unknown>[]> {
  return (await listDatasourceSamples(store))
    .filter((s) => s.datasource_id === id)
    .map((s) => JSON.parse(s.value_json) as Record<string, unknown>);
}

describe("shapeSample", () => {
  test("spreads an object and stamps the sample time", () => {
    const row = shapeSample({ cpu: 42, mem: 61 }, Date.UTC(2026, 8, 23));
    expect(row).toEqual({ cpu: 42, mem: 61, sampled_at: "2026-09-23T00:00:00.000Z" });
  });

  test("wraps a scalar as {value}, matching toRecords", () => {
    expect(shapeSample(42, 0)).toMatchObject({ value: 42 });
    expect(shapeSample(null, 0)).toMatchObject({ value: null });
  });

  test("shadows a colliding field rather than producing two timestamps", () => {
    expect(shapeSample({ sampled_at: "theirs" }, 0).sampled_at).not.toBe("theirs");
  });
});

describe("rowsForMerge", () => {
  test("keys each row by the chosen field", () => {
    expect(rowsForMerge([{ t: "a", v: 1 }, { t: "b", v: 2 }], "t")).toEqual([
      { key: "a", row: { t: "a", v: 1 } },
      { key: "b", row: { t: "b", v: 2 } },
    ]);
  });

  test("stringifies non-string keys", () => {
    expect(rowsForMerge([{ id: 7 }], "id")[0]!.key).toBe("7");
  });

  test("an empty response is not an error", () => {
    expect(rowsForMerge([], "t")).toEqual([]);
  });

  test("refuses a response it cannot merge", () => {
    expect(() => rowsForMerge({ cpu: 1 }, "t")).toThrow(/array/);
    expect(() => rowsForMerge([{ cpu: 1 }], "t")).toThrow(/"t"/);
    expect(() => rowsForMerge([{ t: 1 }], "")).toThrow(/key field/);
  });
});

describe("trackLimit", () => {
  test("defaults and clamps", () => {
    expect(trackLimit(null)).toBe(DEFAULT_TRACK_LIMIT);
    expect(trackLimit(Number.NaN)).toBe(DEFAULT_TRACK_LIMIT);
    expect(trackLimit(1)).toBe(2);
    expect(trackLimit(50)).toBe(50);
    expect(trackLimit(999_999)).toBe(10_000);
  });
});

describe("sample mode", () => {
  test("appends one row per fetch and keeps them distinct", async () => {
    const id = await tracked("sample");
    await recordDatasourceFetch(store, { datasource_id: id, value: { cpu: 1 }, track_mode: "sample" }, 1_000);
    await recordDatasourceFetch(store, { datasource_id: id, value: { cpu: 2 }, track_mode: "sample" }, 2_000);

    const rows = await samplesOf(id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.cpu)).toEqual([1, 2]);
  });

  test("two fetches in the same millisecond do not collide", async () => {
    const id = await tracked("sample");
    await recordDatasourceFetch(store, { datasource_id: id, value: { cpu: 1 }, track_mode: "sample" }, 1_000);
    await recordDatasourceFetch(store, { datasource_id: id, value: { cpu: 2 }, track_mode: "sample" }, 1_000);
    expect(await samplesOf(id)).toHaveLength(2);
  });

  test("still writes the latest-value cache", async () => {
    const id = await tracked("sample");
    await recordDatasourceFetch(store, { datasource_id: id, value: { cpu: 9 }, track_mode: "sample" }, 1_000);
    const [cache] = await store.query<{ value_json: string }>(
      `SELECT value_json FROM datasource_cache WHERE datasource_id = ?`,
      [id],
    );
    expect(JSON.parse(cache!.value_json)).toEqual({ cpu: 9 });
  });
});

describe("merge mode", () => {
  test("upserts by key instead of duplicating", async () => {
    const id = await tracked("merge", { track_key: "t" });
    await recordDatasourceFetch(
      store,
      { datasource_id: id, value: [{ t: "10:00", v: 1 }, { t: "10:01", v: 2 }], track_mode: "merge", track_key: "t" },
      1_000,
    );
    await recordDatasourceFetch(
      store,
      { datasource_id: id, value: [{ t: "10:01", v: 22 }, { t: "10:02", v: 3 }], track_mode: "merge", track_key: "t" },
      2_000,
    );

    const rows = await samplesOf(id);
    expect(rows).toHaveLength(3);
    // The overlapping row was corrected, not duplicated.
    expect(rows.find((r) => r.t === "10:01")!.v).toBe(22);
  });

  test("the stored series outgrows the window the API returns", async () => {
    const id = await tracked("merge", { track_key: "t" });
    // A three-point window sliding by one, five times: the API never shows more than 3.
    for (let poll = 0; poll < 5; poll++) {
      const window = [0, 1, 2].map((i) => ({ t: `p${poll + i}`, v: poll + i }));
      await recordDatasourceFetch(
        store,
        { datasource_id: id, value: window, track_mode: "merge", track_key: "t" },
        1_000 + poll,
      );
    }
    expect((await samplesOf(id)).length).toBeGreaterThan(3);
    expect(await samplesOf(id)).toHaveLength(7);
  });

  test("a response it cannot merge raises instead of storing nothing silently", async () => {
    const id = await tracked("merge", { track_key: "t" });
    await expect(
      recordDatasourceFetch(
        store,
        { datasource_id: id, value: { cpu: 1 }, track_mode: "merge", track_key: "t" },
        1_000,
      ),
    ).rejects.toThrow(/array/);
    expect(await samplesOf(id)).toHaveLength(0);
  });
});

describe("eviction", () => {
  test("keeps exactly the newest N", async () => {
    const id = await tracked("sample", { track_limit: 3 });
    for (let i = 1; i <= 5; i++) {
      await recordDatasourceFetch(
        store,
        { datasource_id: id, value: { n: i }, track_mode: "sample", track_limit: 3 },
        1_000 * i,
      );
    }
    const rows = await samplesOf(id);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.n)).toEqual([3, 4, 5]);
  });

  test("is deterministic when rows share an ingest time", async () => {
    const id = await tracked("sample", { track_limit: 2 });
    for (let i = 1; i <= 4; i++) {
      await recordDatasourceFetch(
        store,
        { datasource_id: id, value: { n: i }, track_mode: "sample", track_limit: 2 },
        1_000,
      );
    }
    const rows = await samplesOf(id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.n)).toEqual([3, 4]);
  });

  test("does not touch another source's history", async () => {
    const a = await tracked("sample", { track_limit: 2 });
    const b = await tracked("sample", { track_limit: 2 });
    for (let i = 1; i <= 3; i++) {
      await recordDatasourceFetch(store, { datasource_id: a, value: { n: i }, track_mode: "sample", track_limit: 2 }, i);
    }
    await recordDatasourceFetch(store, { datasource_id: b, value: { n: 1 }, track_mode: "sample", track_limit: 2 }, 9);
    expect(await samplesOf(a)).toHaveLength(2);
    expect(await samplesOf(b)).toHaveLength(1);
  });
});

describe("lifecycle", () => {
  test("untracked sources record no history", async () => {
    const id = await createDatasource(store, {
      kind: "external",
      name: "plain",
      url: "https://example.invalid/x",
      fetch_mode: "poll",
    });
    await recordDatasourceFetch(store, { datasource_id: id, value: { cpu: 1 } }, 1_000);
    expect(await samplesOf(id)).toHaveLength(0);
  });

  test("changing the mode purges history", async () => {
    const id = await tracked("sample");
    await recordDatasourceFetch(store, { datasource_id: id, value: { cpu: 1 }, track_mode: "sample" }, 1_000);
    await updateDatasource(store, id, { track_mode: "merge", track_key: "t" });
    expect(await samplesOf(id)).toHaveLength(0);
  });

  test("changing the merge key purges history", async () => {
    const id = await tracked("merge", { track_key: "t" });
    await recordDatasourceFetch(
      store,
      { datasource_id: id, value: [{ t: "a" }], track_mode: "merge", track_key: "t" },
      1_000,
    );
    await updateDatasource(store, id, { track_key: "id" });
    expect(await samplesOf(id)).toHaveLength(0);
  });

  test("re-saving the same settings keeps history", async () => {
    const id = await tracked("sample", { track_limit: 10 });
    await recordDatasourceFetch(store, { datasource_id: id, value: { cpu: 1 }, track_mode: "sample" }, 1_000);
    await updateDatasource(store, id, { name: "renamed", track_mode: "sample", track_limit: 20 });
    expect(await samplesOf(id)).toHaveLength(1);
  });

  test("deleting the datasource cascades its history", async () => {
    const id = await tracked("sample");
    await recordDatasourceFetch(store, { datasource_id: id, value: { cpu: 1 }, track_mode: "sample" }, 1_000);
    await deleteDatasource(store, id);
    expect(await samplesOf(id)).toHaveLength(0);
  });
});
