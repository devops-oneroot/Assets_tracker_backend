import { randomUUID } from "crypto";
import { asDate } from "./Asset";

/** Every uncategorised vendor lands here rather than with a blank category. */
const DEFAULT_CATEGORY = "General";

/**
 * The vendor master: one shared list of suppliers, used across both
 * companies. A vendor is not owned by ENP or GCC, so unlike assets and
 * purchase orders this table has no `entity` partition key - just a
 * generated `id`.
 *
 * A purchase order still stores its own copy of the supplier block (name,
 * GST, contact, phone, email) at the time it was raised, the same way it
 * stores its own copy of the buyer block. Picking a vendor on the PO form
 * only *pre-fills* those fields; it does not link the two records, so a
 * vendor's details can change later without rewriting orders already issued
 * against it.
 */

export interface VendorRaw {
  id: string;
  name: string;
  vendorCode: string;
  /**
   * What this vendor is bought for, e.g. "Steel & Structural" - drives the
   * vendor code's prefix. Free text: there is no fixed list, anyone can type
   * a new one on the vendor form or a PO's Supplier section.
   */
  category: string;
  gstNumber: string;
  address: string;
  contactPerson: string;
  phone: string;
  email: string;
  /** Free-text tags: what this vendor is known to supply, e.g. "MS Structural Steel". */
  suppliesTags: string[];
  notes: string;
  createdAt: Date;
  updatedAt: Date;
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

export const newVendorId = (): string => randomUUID();

/**
 * Normalises a raw DynamoDB item into a complete vendor: every field present,
 * dates revived from ISO strings, the tag list never undefined.
 */
export function normalizeVendor(raw: Record<string, unknown>): VendorRaw {
  return {
    id: str(raw.id),
    name: str(raw.name),
    vendorCode: str(raw.vendorCode),
    category: str(raw.category).trim() || DEFAULT_CATEGORY,
    gstNumber: str(raw.gstNumber).toUpperCase(),
    address: str(raw.address),
    contactPerson: str(raw.contactPerson),
    phone: str(raw.phone),
    email: str(raw.email).toLowerCase(),
    suppliesTags: Array.isArray(raw.suppliesTags)
      ? raw.suppliesTags.map(str).filter(Boolean)
      : [],
    notes: str(raw.notes),
    createdAt: asDate(raw.createdAt) ?? new Date(),
    updatedAt: asDate(raw.updatedAt) ?? new Date(),
  };
}

/** Everything the search box looks at, lowercased into one attribute. */
export function buildVendorSearchText(v: VendorRaw): string {
  return [
    v.name,
    v.vendorCode,
    v.category,
    v.gstNumber,
    v.contactPerson,
    v.phone,
    v.email,
    ...v.suppliesTags,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** Turns a vendor into the plain item DynamoDB stores (Dates become ISO strings). */
export function toItem(v: VendorRaw): Record<string, unknown> {
  const item = JSON.parse(JSON.stringify(v)) as Record<string, unknown>;
  item.searchText = buildVendorSearchText(v);
  return item;
}

export type VendorApi = VendorRaw & { _id: string };

export function toApi(v: VendorRaw): VendorApi {
  return { ...v, _id: v.id };
}
