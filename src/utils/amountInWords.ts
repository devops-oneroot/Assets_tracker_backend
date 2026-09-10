/**
 * Rupees in words, in the Indian system — thousand, lakh, crore rather than
 * thousand, million, billion.
 *
 * A purchase order is a document someone signs, so the total is spelled out
 * beneath the figures the way it is on an invoice or a cheque.
 */

const ONES = [
  "",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
];

const TENS = [
  "",
  "",
  "Twenty",
  "Thirty",
  "Forty",
  "Fifty",
  "Sixty",
  "Seventy",
  "Eighty",
  "Ninety",
];

/** 0–99. Anything above is split by the caller. */
function underHundred(n: number): string {
  if (n < 20) return ONES[n] ?? "";
  const tens = TENS[Math.floor(n / 10)] ?? "";
  const ones = ONES[n % 10] ?? "";
  return ones ? `${tens} ${ones}` : tens;
}

function underThousand(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (!hundreds) return underHundred(rest);
  const head = `${ONES[hundreds]} Hundred`;
  return rest ? `${head} ${underHundred(rest)}` : head;
}

/** Whole rupees in words, with no "Rupees" prefix or "Only" suffix. */
export function numberToWords(value: number): string {
  const n = Math.floor(Math.abs(value));
  if (n === 0) return "Zero";

  // Indian grouping: crore, lakh, thousand, then the last three digits.
  const parts: string[] = [];
  const crore = Math.floor(n / 10000000);
  const lakh = Math.floor((n % 10000000) / 100000);
  const thousand = Math.floor((n % 100000) / 1000);
  const rest = n % 1000;

  // Beyond 99 crore the count itself needs the same grouping, so recurse.
  if (crore) parts.push(`${crore > 99 ? numberToWords(crore) : underHundred(crore)} Crore`);
  if (lakh) parts.push(`${underHundred(lakh)} Lakh`);
  if (thousand) parts.push(`${underHundred(thousand)} Thousand`);
  if (rest) parts.push(underThousand(rest));

  return parts.join(" ");
}

/**
 * The full line as printed: "Rupees Two Lakh Eighteen Thousand Three Hundred and
 * Fifty Paise Only".
 */
export function rupeesInWords(value: number): string {
  const amount = Math.abs(Number(value) || 0);
  const whole = Math.floor(amount);
  // Rounded, not truncated — 0.999 is one paisa short of a rupee, not zero.
  const paise = Math.round((amount - whole) * 100);

  const sign = Number(value) < 0 ? "Minus " : "";
  const head = `${sign}Rupees ${numberToWords(whole)}`;
  return paise
    ? `${head} and ${numberToWords(paise)} Paise Only`
    : `${head} Only`;
}
