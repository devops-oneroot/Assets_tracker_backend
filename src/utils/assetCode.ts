/**
 * Suggests the next FA code for one company.
 *
 * Each company counts its own series - ENP's codes and GCC's are independent,
 * so both can hold a "7" and mean different assets, exactly as the register
 * already works today.
 *
 * Whatever shape the company's existing codes take is the shape the next one
 * takes: plain numbers stay plain numbers, and a hand-written "FA-00042"
 * continues as "FA-00043" rather than reverting to some format of our own.
 * Only a company with no numbered code yet falls back to starting at 1.
 */

interface ParsedCode {
  /** Everything before the trailing digits, kept exactly as typed. */
  prefix: string;
  number: number;
  /** How many digits the trailing number had, so "007" -> "008", not "8". */
  width: number;
}

function parseCode(code: string): ParsedCode | null {
  const m = /^(.*?)(\d+)\s*$/.exec(code.trim());
  if (!m) return null;
  return { prefix: m[1]!, number: Number(m[2]), width: m[2]!.length };
}

export function nextAssetCode(
  entity: string,
  existing: { entity: string; assetCode: string }[]
): string {
  const needle = entity.trim().toLowerCase();

  const parsed = existing
    .filter((a) => a.entity.trim().toLowerCase() === needle)
    .map((a) => parseCode(a.assetCode))
    .filter((p): p is ParsedCode => !!p);

  if (!parsed.length) return "1";

  // Whichever code carries the highest number is the series in force.
  const top = parsed.reduce((a, b) => (b.number > a.number ? b : a));
  return `${top.prefix}${String(top.number + 1).padStart(top.width, "0")}`;
}
