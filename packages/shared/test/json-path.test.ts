import { describe, expect, test } from "bun:test";
import { extractPath } from "../src/json-path.ts";
import { decodeSecrets, encodeSecrets, formatHeaderLines, parseHeaderLines } from "../src/secrets.ts";

const doc = { data: { items: [{ id: 1 }, { id: 2 }], "a/b": 3 }, n: 5 };

describe("extractPath", () => {
  test("json pointer and dot paths", () => {
    expect(extractPath(doc, "/data/items/1/id")).toBe(2);
    expect(extractPath(doc, "data.items[0].id")).toBe(1);
    expect(extractPath(doc, "data.items.0.id")).toBe(1);
    expect(extractPath(doc, "/data/a~1b")).toBe(3);
    expect(extractPath(doc, "")).toBe(doc);
    expect(extractPath(doc, "/")).toBe(doc);
    expect(extractPath(doc, "nope.deeper")).toBeUndefined();
    expect(extractPath(doc, "/n/x")).toBeUndefined();
  });
});

describe("secrets", () => {
  test("round-trips headers and parses header lines", () => {
    const headers = { Authorization: "Bearer x", "X-Api-Key": "k" };
    expect(decodeSecrets(encodeSecrets({ headers }))).toEqual({ headers });
    expect(decodeSecrets(null)).toEqual({ headers: {} });
    expect(parseHeaderLines("Authorization: Bearer a:b\n\nbad line\nX: y ")).toEqual({ Authorization: "Bearer a:b", X: "y" });
    expect(parseHeaderLines(formatHeaderLines(headers))).toEqual(headers);
  });
});
