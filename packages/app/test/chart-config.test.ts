// A negative UTC offset, so the date-only case would visibly regress if the formatter stopped
// pinning wall-clock dates to UTC.
process.env.TZ = "America/New_York";

import { describe, expect, test } from "bun:test";
import { labelFormatters, MAX_CATEGORY_TICKS, parseIsoLike } from "../src/lib/elements/chart-config.ts";

describe("parseIsoLike", () => {
  test("accepts ISO dates and date-times", () => {
    expect(parseIsoLike("2026-09-23")).toBeInstanceOf(Date);
    expect(parseIsoLike("2026-09-23T02:25:38.706Z")).toBeInstanceOf(Date);
    expect(parseIsoLike("2026-09-23T02:25")).toBeInstanceOf(Date);
    expect(parseIsoLike("2026-09-23T02:25:38+09:00")).toBeInstanceOf(Date);
  });

  test("rejects what Date.parse would wrongly accept", () => {
    // `new Date("2026")` is a valid date; a column of years or counts is not a timestamp.
    expect(parseIsoLike("2026")).toBeNull();
    expect(parseIsoLike("42")).toBeNull();
    expect(parseIsoLike("Sep 23 2026")).toBeNull();
    expect(parseIsoLike(1790000000000)).toBeNull();
    expect(parseIsoLike(null)).toBeNull();
  });
});

describe("labelFormatters", () => {
  const ticks = (vals: unknown[]) => vals.map((v) => labelFormatters(vals).tick(v));

  test("leaves a column that is not timestamps exactly as it was", () => {
    expect(ticks(["Jan", "Feb", "Mar"])).toEqual(["Jan", "Feb", "Mar"]);
    expect(ticks(["2026", "2027"])).toEqual(["2026", "2027"]);
    expect(ticks([1, 2, 3])).toEqual(["1", "2", "3"]);
  });

  test("leaves a mixed column alone rather than formatting half of it", () => {
    expect(ticks(["2026-09-23T00:00:00Z", "n/a"])).toEqual(["2026-09-23T00:00:00Z", "n/a"]);
  });

  test("renders a timestamp as something other than the raw ISO string", () => {
    const [label] = ticks(["2026-09-23T02:25:38.706Z", "2026-09-23T02:25:43.706Z"]);
    expect(label).not.toContain("T");
    expect(label).not.toContain("Z");
  });

  test("shows seconds when samples are closer together than a minute", () => {
    const vals = ["2026-09-23T02:25:38Z", "2026-09-23T02:25:43Z", "2026-09-23T02:25:48Z"];
    expect(labelFormatters(vals).tick(vals[0])).toMatch(/\d{1,2}:\d{2}:\d{2}/);
  });

  test("drops seconds once samples are a minute apart", () => {
    const vals = ["2026-09-23T02:00:00Z", "2026-09-23T02:05:00Z", "2026-09-23T02:10:00Z"];
    expect(labelFormatters(vals).tick(vals[0])).not.toMatch(/\d{1,2}:\d{2}:\d{2}/);
  });

  test("drops the time entirely for daily buckets", () => {
    const vals = ["2026-09-21T00:00:00Z", "2026-09-22T00:00:00Z", "2026-09-23T00:00:00Z"];
    expect(labelFormatters(vals).tick(vals[0])).not.toMatch(/\d{1,2}:\d{2}/);
  });

  test("a wall-clock date keeps its calendar day in a negative-offset zone", () => {
    // Parsed as UTC midnight; formatted locally it would slip to the 22nd.
    expect(labelFormatters(["2026-09-23", "2026-09-24"]).tick("2026-09-23")).toContain("23");
  });

  test("the tooltip label carries the date even when the axis omits it", () => {
    const vals = ["2026-09-23T02:25:38Z", "2026-09-23T02:25:43Z"];
    const { tick, full } = labelFormatters(vals);
    expect(tick(vals[0])).not.toMatch(/2[23]/);
    expect(full(vals[0])).toMatch(/2[23]/);
  });

  test("an empty column is safe", () => {
    expect(labelFormatters([]).tick("x")).toBe("x");
  });
});

test("the category tick cap is an upper bound", () => {
  expect(MAX_CATEGORY_TICKS).toBeGreaterThan(1);
});
