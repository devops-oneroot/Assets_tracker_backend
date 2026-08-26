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
  purchaseDate?: Date | string | null;
  depreciation?: (Partial<Omit<DepreciationInput, "method">> & { method?: string }) | null;
  warranty?: { expiryDate?: Date | string | null } | null;
}

/**
 * Adds the derived `book` and `warrantyStatus` fields to a stored asset.
 *
 * DynamoDB stores only what is written, so these are recomputed on every read
 * rather than persisted — book value depends on today's date and would go stale.
 */
export function withComputed<T extends ComputableAsset>(
  doc: T
): T & { book: DepreciationResult; warrantyStatus: WarrantyStatus } {
  return {
    ...doc,
    book: computeDepreciation(doc.purchaseCost ?? 0, doc.purchaseDate ?? null, doc.depreciation),
    warrantyStatus: warrantyStatusOf(doc.warranty?.expiryDate),
  };
}
