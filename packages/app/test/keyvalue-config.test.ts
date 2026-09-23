process.env.TZ = "America/New_York";

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_KEYVALUE,
  formatValue,
  keyValueRows,
  parseKeyValueConfig,
  type KeyValueConfig,
} from "../src/lib/elements/keyvalue-config.ts";

const cfg = (over: Partial<KeyValueConfig> = {}): KeyValueConfig => ({ ...DEFAULT_KEYVALUE, ...over });

describe("parseKeyValueConfig", () => {
  test("defaults to auto, and survives nonsense", () => {
    expect(parseKeyValueConfig("{}")).toEqual(DEFAULT_KEYVALUE);
    expect(parseKeyValueConfig("not json")).toEqual(DEFAULT_KEYVALUE);
    expect(parseKeyValueConfig(JSON.stringify({ label: 7, value: null }))).toEqual(DEFAULT_KEYVALUE);
  });

  test("keeps chosen fields", () => {
    expect(parseKeyValueConfig(JSON.stringify({ label: "name", value: "v", metric: "u" }))).toEqual({
      label: "name",
      value: "v",
      metric: "u",
    });
  });
});

describe("keyValueRows", () => {
  test("a single record needs no configuration at all", () => {
    const rows = keyValueRows({ cpu: 42, memory: 61.4 }, cfg());
    expect(rows.map((r) => [r.key, r.display])).toEqual([
      ["cpu", "42"],
      ["memory", "61.4"],
    ]);
  });

  test("chosen fields turn records into rows", () => {
    const data = [
      { name: "Latency", v: 1240, u: "ms" },
      { name: "Payload", v: 1536, u: "bytes" },
    ];
    const rows = keyValueRows(data, cfg({ label: "name", value: "v", metric: "u" }));
    expect(rows.map((r) => [r.key, r.display])).toEqual([
      ["Latency", "1.24 s"],
      ["Payload", "1.5 KB"],
    ]);
  });

  test("the metric field is optional", () => {
    const rows = keyValueRows([{ name: "Errors", v: 3 }], cfg({ label: "name", value: "v" }));
    expect(rows).toEqual([{ key: "Errors", display: "3" }]);
  });

  test("several records with nothing chosen yields nothing, so the view can ask", () => {
    expect(keyValueRows([{ a: 1 }, { b: 2 }], cfg())).toEqual([]);
  });

  test("an empty dataset is not an error", () => {
    expect(keyValueRows([], cfg())).toEqual([]);
    expect(keyValueRows(null, cfg())).toEqual([]);
  });

  test("a long value is truncated, keeping the original for a tooltip", () => {
    const long = "x".repeat(200);
    const [row] = keyValueRows({ note: long }, cfg());
    expect(row!.display.endsWith("…")).toBe(true);
    expect(row!.display.length).toBeLessThan(long.length);
    expect(row!.title).toBe(long);
  });
});

describe("formatValue — inferred", () => {
  test("absent values read as a dash", () => {
    expect(formatValue(null)).toBe("—");
    expect(formatValue(undefined)).toBe("—");
  });

  test("booleans read as words", () => {
    expect(formatValue(true)).toBe("Yes");
    expect(formatValue(false)).toBe("No");
  });

  test("numbers are grouped", () => {
    expect(formatValue(1234567)).toBe((1234567).toLocaleString());
    expect(formatValue(61.42)).toBe((61.42).toLocaleString());
  });

  test("a numeric string becomes a number only when it round-trips", () => {
    expect(formatValue("42")).toBe("42");
    // Identifiers and versions must survive intact rather than being mangled.
    expect(formatValue("0042")).toBe("0042");
    expect(formatValue("1.2.3")).toBe("1.2.3");
    expect(formatValue("")).toBe("");
  });

  test("ISO timestamps are localized", () => {
    const out = formatValue("2026-09-23T14:30:00.000Z");
    expect(out).not.toContain("T");
    expect(out).not.toContain("Z");
  });

  test("a wall-clock date keeps its day in a negative-offset zone", () => {
    // Parsed as UTC midnight; formatted locally it would slip to the 22nd.
    expect(formatValue("2026-09-23")).toContain("23");
  });

  test("objects are shown compactly rather than as [object Object]", () => {
    expect(formatValue({ a: 1 })).toBe('{"a":1}');
    expect(formatValue([1, 2])).toBe("[1,2]");
  });
});

describe("formatValue — with a unit", () => {
  test("durations climb the ladder", () => {
    expect(formatValue(840, "ms")).toBe("840 ms");
    expect(formatValue(1240, "ms")).toBe("1.24 s");
    expect(formatValue(90_000, "ms")).toBe("1m 30s");
    expect(formatValue(7_200_000, "ms")).toBe("2h 0m");
    // Seconds are the same ladder, scaled.
    expect(formatValue(90, "s")).toBe("1m 30s");
  });

  test("bytes climb in 1024 steps", () => {
    expect(formatValue(512, "bytes")).toBe("512 B");
    expect(formatValue(1536, "B")).toBe("1.5 KB");
    expect(formatValue(1024 * 1024 * 3, "bytes")).toBe("3 MB");
  });

  test("a percentage at or below one is read as a fraction", () => {
    expect(formatValue(0.985, "%")).toBe("98.5%");
    expect(formatValue(1, "%")).toBe("100%");
    // Above one it is already a percentage, so it is left alone.
    expect(formatValue(42, "%")).toBe("42%");
    expect(formatValue(1240, "%")).toBe((1240).toLocaleString() + "%");
  });

  test("a currency code formats as money", () => {
    const out = formatValue(1240, "USD");
    expect(out).toMatch(/1,?240/);
    expect(out).toMatch(/\$|USD/);
  });

  test("an unknown unit is appended verbatim", () => {
    expect(formatValue(1240, "rpm")).toBe(`${(1240).toLocaleString()} rpm`);
    expect(formatValue("fast", "rpm")).toBe("fast rpm");
  });

  test("a unit never turns an absent value into a number", () => {
    expect(formatValue(null, "ms")).toBe("—");
  });

  test("negatives keep their sign through the ladders", () => {
    expect(formatValue(-1536, "bytes")).toBe("-1.5 KB");
    expect(formatValue(-1240, "ms")).toBe("-1.24 s");
  });
});
