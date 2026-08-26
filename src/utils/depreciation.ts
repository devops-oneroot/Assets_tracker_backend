export type DepreciationMethod = "SLM" | "WDV" | "None";

export interface DepreciationInput {
  method: DepreciationMethod;
  ratePercent: number;
  usefulLifeYears: number;
  salvageValue: number;
}

export interface DepreciationResult {
  yearsElapsed: number;
  annualDepreciation: number;
  accumulatedDepreciation: number;
  currentValue: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Straight Line (SLM) and Written Down Value (WDV) book-value calculation.
 * If a rate is supplied it wins; otherwise SLM falls back to useful life.
 */
export function computeDepreciation(
  purchaseCost: number,
  purchaseDate: Date | string | null | undefined,
  dep: (Partial<Omit<DepreciationInput, "method">> & { method?: string }) | null | undefined,
  asOf: Date = new Date()
): DepreciationResult {
  const cost = Number(purchaseCost) || 0;
  const method = dep?.method ?? "SLM";
  const rate = Number(dep?.ratePercent) || 0;
  const life = Number(dep?.usefulLifeYears) || 0;
  const salvage = Math.min(Number(dep?.salvageValue) || 0, cost);

  const empty: DepreciationResult = {
    yearsElapsed: 0,
    annualDepreciation: 0,
    accumulatedDepreciation: 0,
    currentValue: round2(cost),
  };

  if (!cost || !purchaseDate || method === "None") return empty;

  const ms = asOf.getTime() - new Date(purchaseDate).getTime();
  if (ms <= 0) return empty;
  const yearsElapsed = ms / (365.25 * 24 * 60 * 60 * 1000);

  if (method === "WDV") {
    if (rate <= 0) return { ...empty, yearsElapsed: round2(yearsElapsed) };
    const currentValue = Math.max(cost * Math.pow(1 - rate / 100, yearsElapsed), salvage);
    return {
      yearsElapsed: round2(yearsElapsed),
      annualDepreciation: round2(cost * (rate / 100)),
      accumulatedDepreciation: round2(cost - currentValue),
      currentValue: round2(currentValue),
    };
  }

  // SLM
  let annual = 0;
  if (rate > 0) annual = cost * (rate / 100);
  else if (life > 0) annual = (cost - salvage) / life;
  if (annual <= 0) return { ...empty, yearsElapsed: round2(yearsElapsed) };

  const accumulated = Math.min(annual * yearsElapsed, cost - salvage);
  return {
    yearsElapsed: round2(yearsElapsed),
    annualDepreciation: round2(annual),
    accumulatedDepreciation: round2(accumulated),
    currentValue: round2(cost - accumulated),
  };
}
