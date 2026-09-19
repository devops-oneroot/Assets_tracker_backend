/**
 * Turns a free-text vendor category into the 3-letter prefix its codes use,
 * e.g. "Steel & Structural" -> "STE".
 *
 * Categories are open-ended - anyone can type a new one on the vendor form
 * or the PO form's Supplier section, there is no fixed list to validate
 * against. That means two different categories could in principle derive the
 * same prefix (e.g. "Steel" and "Sterling Silver" both -> "STE"). Rather than
 * try to prevent that up front, `nextVendorCode` below scopes its sequence to
 * vendors whose *category text* actually matches, not to the prefix - so a
 * shared prefix is a cosmetic coincidence, never a numbering collision.
 */
export function derivePrefix(category: string): string {
  const letters = category
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
  return letters.slice(0, 3) || "GEN";
}

interface ParsedCode {
  /** Everything before the trailing digits, kept exactly as typed - dashes, casing, all of it. */
  prefix: string;
  number: number;
  /** How many digits the trailing number had, so "01" -> "02", not "2". */
  width: number;
}

/** Splits "ISC-C-01" into { prefix: "ISC-C-", number: 1, width: 2 }, or null if there's no trailing number at all. */
function parseCode(code: string): ParsedCode | null {
  const m = /^(.*?)(\d+)\s*$/.exec(code.trim());
  if (!m) return null;
  return { prefix: m[1]!, number: Number(m[2]), width: m[2]!.length };
}

/**
 * The next free code for a category, given every vendor already on file.
 *
 * Scoped by an exact (trimmed, case-insensitive) match on the category text
 * itself, so it can never be thrown off by an unrelated category that
 * happens to derive the same prefix.
 *
 * If someone has already hand-edited a vendor's code for this category (e.g.
 * changed an auto-generated "INP0001" to their own "ISC-C-01"), the next
 * suggestion continues *that* pattern - same prefix, same digit width -
 * rather than reverting to the generic one derived from the category name.
 * Only a category with no numbered code yet falls back to deriving a fresh
 * prefix from its own text.
 */
export function nextVendorCode(
  category: string,
  existing: { category: string; vendorCode: string }[]
): string {
  const needle = category.trim().toLowerCase();
  const sameCategory = needle
    ? existing.filter((v) => v.category.trim().toLowerCase() === needle)
    : [];

  const parsed = sameCategory
    .map((v) => parseCode(v.vendorCode))
    .filter((p): p is ParsedCode => !!p);

  if (parsed.length) {
    // Whichever code carries the highest number is the pattern currently in
    // force for this category - continue it.
    const top = parsed.reduce((a, b) => (b.number > a.number ? b : a));
    return `${top.prefix}${String(top.number + 1).padStart(top.width, "0")}`;
  }

  // Nobody in this category has a numbered code yet - seed one from the
  // category name itself.
  const prefix = derivePrefix(category || "General");
  return `${prefix}0001`;
}
