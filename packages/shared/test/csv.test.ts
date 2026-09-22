import { describe, expect, test } from "bun:test";
import { csvToRecords, detectDelimiter, inferCsvValue, parseCsv } from "../src/csv.ts";

describe("csv", () => {
  test("detects the delimiter from the header line", () => {
    expect(detectDelimiter("a,b,c\n1,2,3")).toBe(",");
    expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(detectDelimiter("a\tb\n1\t2")).toBe("\t");
    expect(detectDelimiter("\n\nx;y")).toBe(";");
  });

  test("parses quotes, escaped quotes, embedded delimiters and newlines, CRLF and BOM", () => {
    const text = '﻿name,note\r\n"Smith, J","said ""hi""\nthen left"\r\nDoe,\r\n';
    expect(parseCsv(text)).toEqual([
      ["name", "note"],
      ["Smith, J", 'said "hi"\nthen left'],
      ["Doe", ""],
    ]);
  });

  test("infers value types", () => {
    expect(inferCsvValue("")).toBeNull();
    expect(inferCsvValue(" 3 ")).toBe(3);
    expect(inferCsvValue("-1.5e3")).toBe(-1500);
    expect(inferCsvValue("TRUE")).toBe(true);
    expect(inferCsvValue("false")).toBe(false);
    expect(inferCsvValue("007")).toBe(7);
    expect(inferCsvValue("1,234")).toBe("1,234");
    expect(inferCsvValue("2024-01-05")).toBe("2024-01-05");
  });

  test("builds records with typed cells, duplicate/blank headers and ragged rows", () => {
    const text = "name;qty;;qty\nSmith;3;x;4\nDoe;;y\nLong;1;z;2;extra";
    expect(csvToRecords(text)).toEqual([
      { name: "Smith", qty: 3, column_3: "x", qty_2: 4 },
      { name: "Doe", qty: null, column_3: "y", qty_2: null },
      { name: "Long", qty: 1, column_3: "z", qty_2: 2, column_5: "extra" },
    ]);
    expect(csvToRecords("")).toEqual([]);
    expect(csvToRecords("only,header")).toEqual([]);
  });
});
