const DELIMITERS = [",", ";", "\t"] as const;
export type CsvDelimiter = (typeof DELIMITERS)[number];

/** Picks the delimiter that occurs most in the first non-empty line (comma on ties). */
export function detectDelimiter(text: string): CsvDelimiter {
  const line = text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  let best: CsvDelimiter = ",";
  let bestCount = -1;
  for (const d of DELIMITERS) {
    const n = line.split(d).length - 1;
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}

/** RFC 4180 style parser: quoted fields, doubled quotes, delimiters/newlines inside quotes, CRLF. */
export function parseCsv(text: string, opts: { delimiter?: CsvDelimiter } = {}): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delimiter = opts.delimiter ?? detectDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      quoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

/** "" → null, true/false → boolean, plain numeric strings → number, else the trimmed string. */
export function inferCsvValue(raw: string): unknown {
  const s = raw.trim();
  if (s === "") return null;
  const lower = s.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  if (/^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  return s;
}

/** Header row → keys (duplicates suffixed, blanks named column_N); remaining rows → typed records. */
export function csvToRecords(text: string, opts: { delimiter?: CsvDelimiter } = {}): Record<string, unknown>[] {
  const rows = parseCsv(text, opts);
  if (rows.length === 0) return [];
  const [header, ...body] = rows;
  const keys: string[] = [];
  const seen = new Map<string, number>();
  header!.forEach((h, i) => {
    let key = h.trim() || `column_${i + 1}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    if (n > 0) key = `${key}_${n + 1}`;
    keys.push(key);
  });

  return body.map((cells) => {
    const record: Record<string, unknown> = {};
    const width = Math.max(keys.length, cells.length);
    for (let i = 0; i < width; i++) {
      const key = keys[i] ?? `column_${i + 1}`;
      record[key] = i < cells.length ? inferCsvValue(cells[i]!) : null;
    }
    return record;
  });
}
