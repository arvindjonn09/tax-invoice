// CSV exports (#56, #70). RFC 4180: comma-separated, CRLF line ends, UTF-8,
// a header row. Columns are typed so money leaves as the authoritative
// integer cents in ASCII (`-1500`), never display text: no currency
// symbol, digit grouping, GST label or typographic minus. Text cells that a
// spreadsheet could run as a formula are neutralised with a leading `'`.

export type CsvColumnType = "text" | "cents" | "date" | "integer" | "boolean";
export type CsvColumn<Row> = {
  name: string;
  type: CsvColumnType;
  value: (row: Row) => string | bigint | number | boolean | null;
};

/**
 * Leading characters that make a spreadsheet treat a cell as a formula or
 * command, after any leading whitespace or control characters (OWASP CSV
 * injection). Control characters themselves can also start one.
 */
const FORMULA = /^[\s\u0000-\u001f\u007f]*[=+\-@＝＋－＠]/;
const LEADING_CONTROL = /^[\t\r\n\u0000-\u001f\u007f]/;

export function neutralise(text: string): string {
  return FORMULA.test(text) || LEADING_CONTROL.test(text) ? `'${text}` : text;
}

const quote = (text: string) => `"${text.replace(/"/g, '""')}"`;

function cell(type: CsvColumnType, value: unknown, column: string): string {
  if (value === null || value === undefined) return "";
  switch (type) {
    case "cents":
      if (typeof value !== "bigint")
        throw new TypeError(`${column}: money must be bigint cents`);
      return value.toString();
    case "integer":
      if (typeof value === "bigint") return value.toString();
      if (typeof value !== "number" || !Number.isSafeInteger(value))
        throw new TypeError(`${column}: expected a safe integer`);
      return String(value);
    case "date":
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
        throw new TypeError(`${column}: expected an ISO date`);
      return value;
    case "boolean":
      if (typeof value !== "boolean")
        throw new TypeError(`${column}: expected a boolean`);
      return value ? "true" : "false";
    case "text":
      return quote(neutralise(String(value)));
  }
}

export function csvHeader<Row>(columns: readonly CsvColumn<Row>[]): string {
  return `${columns.map((c) => c.name).join(",")}\r\n`;
}

export function csvLine<Row>(
  columns: readonly CsvColumn<Row>[],
  row: Row,
): string {
  return `${columns.map((c) => cell(c.type, c.value(row), c.name)).join(",")}\r\n`;
}

/** Whole CSV text; handy in tests. Routes stream with `csvStream`. */
export function toCsv<Row>(
  columns: readonly CsvColumn<Row>[],
  rows: Iterable<Row>,
): string {
  let text = csvHeader(columns);
  for (const row of rows) text += csvLine(columns, row);
  return text;
}

/**
 * Stream rows already read inside one database snapshot, in chunks, so a
 * large export never builds one huge string.
 */
export function csvStream<Row>(
  columns: readonly CsvColumn<Row>[],
  rows: Iterable<Row>,
  chunkRows = 500,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = rows[Symbol.iterator]();
  let header = true;
  return new ReadableStream({
    pull(controller) {
      let chunk = header ? csvHeader(columns) : "";
      header = false;
      for (let i = 0; i < chunkRows; i += 1) {
        const next = iterator.next();
        if (next.done) {
          if (chunk) controller.enqueue(encoder.encode(chunk));
          controller.close();
          return;
        }
        chunk += csvLine(columns, next.value);
      }
      controller.enqueue(encoder.encode(chunk));
    },
  });
}
