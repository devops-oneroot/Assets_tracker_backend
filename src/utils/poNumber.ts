/**
 * Automatic PO numbering.
 *
 * Two styles are in use and both are supported, because the register already
 * contains both:
 *
 *   `049/2025-26`  a sequence plus the Indian financial year, as on the printed
 *                  orders. The sequence restarts each April.
 *   `032`          a plain running number that never restarts.
 *
 * Rather than impose one, the next number continues whichever style that
 * company's own register already uses. Introducing a year-suffixed number
 * switches that company to the year style from then on.
 *
 * The rule that matters most: the series belongs to the *company*. ENP and GCC
 * each count from their own 001, the two are never interleaved, and one company
 * raising an order must never move the other's next number. Callers are
 * responsible for passing one company's numbers and nobody else's - a mixed
 * list would silently merge two registers.
 */

/** Default padding when there is nothing to copy — "001", not "1". */
const DEFAULT_WIDTH = 3;

/** "049/2025-26", tolerating stray spaces. */
const YEAR_PATTERN = /^\s*(\d{1,6})\s*\/\s*(\d{4})\s*-\s*(\d{2})\s*$/;
/** "032" — a bare running number. */
const PLAIN_PATTERN = /^\s*(\d{1,6})\s*$/;

export type PoNumberStyle = "financial-year" | "plain";

export interface ParsedPoNumber {
  sequence: number;
  /** null for a plain number, which belongs to no particular year. */
  financialYear: string | null;
  /** How many digits the sequence was written with, so padding is preserved. */
  width: number;
}

/**
 * The Indian financial year containing `date`, as "2025-26".
 *
 * The year turns on 1 April, so 15/04/2025 and 31/03/2026 are both 2025-26.
 */
export function financialYear(date: Date | null | undefined): string {
  const d = date && !Number.isNaN(date.getTime()) ? date : new Date();
  const month = d.getMonth(); // 0 = January
  const startYear = month >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  const endYear = (startYear + 1) % 100;
  return `${startYear}-${String(endYear).padStart(2, "0")}`;
}

/** Reads a stored PO number, or null if it follows neither pattern. */
export function parsePoNumber(value: string): ParsedPoNumber | null {
  const raw = value ?? "";

  const withYear = YEAR_PATTERN.exec(raw);
  if (withYear) {
    return {
      sequence: Number(withYear[1]),
      financialYear: `${withYear[2]}-${withYear[3]}`,
      width: withYear[1]!.length,
    };
  }

  const plain = PLAIN_PATTERN.exec(raw);
  if (plain) {
    return { sequence: Number(plain[1]), financialYear: null, width: plain[1]!.length };
  }

  return null;
}

const pad = (sequence: number, width: number): string =>
  String(sequence).padStart(Math.max(width, DEFAULT_WIDTH), "0");

export const formatPoNumber = (
  sequence: number,
  width: number,
  fy: string | null
): string => (fy ? `${pad(sequence, width)}/${fy}` : pad(sequence, width));

/** The entry with the highest sequence, or null when there are none. */
function highest(entries: ParsedPoNumber[]): ParsedPoNumber | null {
  return entries.reduce<ParsedPoNumber | null>(
    (best, entry) => (!best || entry.sequence > best.sequence ? entry : best),
    null
  );
}

export interface NextNumber {
  poNumber: string;
  style: PoNumberStyle;
  /** The year the number belongs to, or null for a plain running number. */
  financialYear: string | null;
}

/**
 * The next number for one company.
 *
 * Numbers matching neither pattern are ignored rather than rejected, so a
 * hand-typed one-off ("SPECIAL-ORDER-A") cannot break the sequence for
 * everything that follows it.
 */
export function nextPoNumber(existing: string[], fy: string): NextNumber {
  const parsed = existing
    .map(parsePoNumber)
    .filter((p): p is ParsedPoNumber => p !== null);

  const yearStyle = parsed.filter((p) => p.financialYear !== null);

  if (yearStyle.length) {
    // Only this year's orders set the sequence; a new financial year starts again
    // at 001 while still copying the padding the company writes numbers with.
    const thisYear = highest(yearStyle.filter((p) => p.financialYear === fy));
    const anyYear = highest(yearStyle);
    const width = thisYear?.width ?? anyYear?.width ?? DEFAULT_WIDTH;

    return {
      poNumber: formatPoNumber((thisYear?.sequence ?? 0) + 1, width, fy),
      style: "financial-year",
      financialYear: fy,
    };
  }

  const plain = highest(parsed);
  if (plain) {
    return {
      poNumber: formatPoNumber(plain.sequence + 1, plain.width, null),
      style: "plain",
      financialYear: null,
    };
  }

  // Nothing to copy: start with the style the printed orders use.
  return {
    poNumber: formatPoNumber(1, DEFAULT_WIDTH, fy),
    style: "financial-year",
    financialYear: fy,
  };
}
