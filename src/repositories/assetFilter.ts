/**
 * Builds a DynamoDB FilterExpression from the dashboard's query string.
 *
 * Every filter and the search box are evaluated by DynamoDB itself rather than in
 * Node. Note what this does and does not buy you: a FilterExpression is applied
 * *after* items are read, so it cuts the data crossing the network but not the
 * capacity consumed. Only the `entity` filter narrows the read itself, because it
 * is the partition key and becomes a Query.
 */

export interface FilterInput {
  search?: string | undefined;
  status?: string | undefined;
  entity?: string | undefined;
  department?: string | undefined;
  location?: string | undefined;
  category?: string | undefined;
  product?: string | undefined;
  verified?: string | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
}

export interface BuiltFilter {
  expression?: string;
  names: Record<string, string>;
  values: Record<string, unknown>;
}

const multi = (value?: string): string[] =>
  value ? value.split(",").map((v) => v.trim()).filter(Boolean) : [];

/** Dates are stored as ISO strings, which compare correctly lexicographically. */
function isoStart(value?: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function isoEnd(value?: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

export interface BuildOptions {
  /**
   * Skip the entity clause. Set when entity is already pinned by a Query's
   * KeyConditionExpression, where repeating it as a filter is invalid.
   */
  skipEntity?: boolean;
}

export function buildFilter(input: FilterInput, options: BuildOptions = {}): BuiltFilter {
  const parts: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};

  // Every attribute goes through a name placeholder — `status`, `location` and
  // friends are DynamoDB reserved words.
  const name = (attr: string): string => {
    const key = `#${attr.replace(/[^A-Za-z0-9]/g, "")}`;
    names[key] = attr;
    return key;
  };

  /** field IN (...) for a comma-separated multi-select. */
  const inList = (attr: string, raw?: string, prefix = attr) => {
    const list = multi(raw);
    if (!list.length) return;
    const placeholders = list.map((v, i) => {
      const key = `:${prefix}${i}`;
      values[key] = v;
      return key;
    });
    parts.push(`${name(attr)} IN (${placeholders.join(", ")})`);
  };

  if (input.search?.trim()) {
    values[":search"] = input.search.trim().toLowerCase();
    parts.push(`contains(${name("searchText")}, :search)`);
  }

  inList("status", input.status, "st");
  if (!options.skipEntity) inList("entity", input.entity, "en");
  inList("department", input.department, "dp");
  inList("location", input.location, "lc");
  inList("category", input.category, "ct");
  inList("product", input.product, "pr");

  if (input.verified === "true" || input.verified === "false") {
    values[":verified"] = input.verified === "true";
    parts.push(`${name("physicalVerification")}.${name("verified")} = :verified`);
  }

  const from = isoStart(input.dateFrom);
  const to = isoEnd(input.dateTo);
  if (from && to) {
    values[":from"] = from;
    values[":to"] = to;
    parts.push(`${name("purchaseDate")} BETWEEN :from AND :to`);
  } else if (from) {
    values[":from"] = from;
    parts.push(`${name("purchaseDate")} >= :from`);
  } else if (to) {
    values[":to"] = to;
    parts.push(`${name("purchaseDate")} <= :to`);
  }

  return {
    ...(parts.length ? { expression: parts.join(" AND ") } : {}),
    names,
    values,
  };
}
