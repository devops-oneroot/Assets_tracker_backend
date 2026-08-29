import { computeDepreciation, type DepreciationInput, type DepreciationResult } from "./depreciation";

export type WarrantyStatus = "In Warranty" | "Expiring Soon" | "Expired" | "Unknown";

/** Warranty is "expiring soon" inside the last 30 days of cover. */
export function warrantyStatusOf(expiry?: Date | string | null): WarrantyStatus {
  if (!expiry) return "Unknown";
  const time = new Date(expiry).getTime();
  if (Number.isNaN(time)) return "Unknown";
  const days = Math.ceil((time - Date.now()) / 86400000);
  if (days < 0) return "Expired";
  if (days <= 30) return "Expiring Soon";
  return "In Warranty";
}

interface ComputableAsset {
  purchaseCost?: number;
  gstPercent?: number;
  purchaseDate?: Date | string | null;
  depreciation?: (Partial<Omit<DepreciationInput, "method">> & { method?: string }) | null;
  warranty?: { expiryDate?: Date | string | null } | null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Adds the derived fields to a stored asset.
 *
 * DynamoDB stores only what is written, so these are recomputed on every read
 * rather than persisted — book value depends on today's date and would go stale,
 * and storing GST alongside the rate would let the two drift apart.
 *
 * Depreciation deliberately runs on `purchaseCost`, before GST: the asset is
 * capitalised at its taxable value because the GST is reclaimed as input credit.
 */
export function withComputed<T extends ComputableAsset>(
  doc: T
): T & {
  book: DepreciationResult;
  warrantyStatus: WarrantyStatus;
  gstAmount: number;
  totalCost: number;
} {
  const cost = doc.purchaseCost ?? 0;
  const gstAmount = round2((cost * (doc.gstPercent ?? 0)) / 100);

  return {
    ...doc,
    book: computeDepreciation(cost, doc.purchaseDate ?? null, doc.depreciation),
    warrantyStatus: warrantyStatusOf(doc.warranty?.expiryDate),
    gstAmount,
    totalCost: round2(cost + gstAmount),
  };
}
