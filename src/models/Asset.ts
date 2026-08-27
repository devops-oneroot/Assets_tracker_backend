import { randomUUID } from "crypto";

export const ASSET_STATUSES = ["Active", "Repair", "Sold", "Scrapped"] as const;
export const DEPRECIATION_METHODS = ["SLM", "WDV", "None"] as const;
/** Which company the asset belongs to. */
export const ENTITIES = ["ENP", "GCC"] as const;

export type AssetStatus = (typeof ASSET_STATUSES)[number];
export type DepreciationMethod = (typeof DEPRECIATION_METHODS)[number];
export type Entity = (typeof ENTITIES)[number];

/** A single file stored on Cloudinary. */
export interface StoredFileDoc {
  url: string;
  publicId: string;
  fileName: string;
  format: string;
  bytes: number;
  resourceType: string;
  uploadedAt: Date | null;
}

/** One maintenance / service event, with its own invoice and photo. */
export interface ServiceDoc {
  _id: string;
  description: string;
  purchaseDate: Date | null;
  serviceDate: Date | null;
  paymentDate: Date | null;
  purchaseCost: number;
  serviceCost: number;
  invoiceNumber: string;
  vendor: string;
  warrantyPeriod: string;
  photo: StoredFileDoc | null;
}

export interface TransferDoc {
  _id: string;
  date: Date | null;
  fromEmployee: string;
  toEmployee: string;
  fromDepartment: string;
  toDepartment: string;
  fromLocation: string;
  toLocation: string;
  remarks: string;
}

export interface AssetRaw {
  /** 🏷️ FA code — typed in by hand, and the DynamoDB partition key. */
  assetCode: string;
  /** 🏛️ Owning company */
  entity: Entity | string;
  /** 📷 Asset photo */
  photo: StoredFileDoc | null;

  product: string;
  category: string;
  brand: string;
  /** 🔢 Product number */
  productNumber: string;

  purchaseDate: Date | null;
  /** 💳 When the invoice was actually paid */
  paymentDate: Date | null;
  /** 🧾 Purchase invoice */
  /** 🧾 Purchase invoices — first is the one shown wherever a single file fits */
  purchaseInvoices: StoredFileDoc[];
  invoiceNumber: string;
  vendor: string;
  purchaseCost: number;

  /** 📉 Depreciation */
  depreciation: {
    method: DepreciationMethod | string;
    ratePercent: number;
    usefulLifeYears: number;
    salvageValue: number;
  };

  /** 👤 Assigned employee */
  assignedEmployee: {
    name: string;
    employeeId: string;
    email: string;
  };
  /** 🏢 Department, 📍 Location */
  department: string;
  location: string;

  /** 🔧 Maintenance & service details */
  serviceRecords: ServiceDoc[];

  /** 📄 Warranty document */
  warranty: {
    provider: string;
    expiryDate: Date | null;
    documents: StoredFileDoc[];
  };

  /** ✅ Physical verification, 📸 verification photo */
  physicalVerification: {
    verified: boolean;
    verifiedOn: Date | null;
    verifiedBy: string;
    remarks: string;
    photo: StoredFileDoc | null;
  };

  /** 🔄 Transfer history */
  transferHistory: TransferDoc[];

  status: AssetStatus | string;
  notes: string;

  createdAt: Date;
  updatedAt: Date;
}

export const newId = (): string => randomUUID();

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Accepts a Date, an ISO string or null and returns a Date or null. */
export function asDate(value: unknown): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

function asFile(value: unknown): StoredFileDoc | null {
  if (!value || typeof value !== "object") return null;
  const f = value as Record<string, unknown>;
  if (!f.url) return null;
  return {
    url: str(f.url),
    publicId: str(f.publicId),
    fileName: str(f.fileName),
    format: str(f.format),
    bytes: num(f.bytes),
    resourceType: str(f.resourceType) || "image",
    uploadedAt: asDate(f.uploadedAt),
  };
}

/**
 * Reads a file list, falling back to the older single-file attribute.
 *
 * Records written before these fields became lists still carry the singular
 * value, so this keeps them readable with no migration; the next save rewrites
 * them as an array.
 */
function fileList(many: unknown, single: unknown): StoredFileDoc[] {
  if (Array.isArray(many)) {
    return many.map(asFile).filter((f): f is StoredFileDoc => !!f);
  }
  const one = asFile(single);
  return one ? [one] : [];
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? (value.filter((v) => v && typeof v === "object") as Record<string, unknown>[])
    : [];
}

/**
 * Normalises a raw DynamoDB item (or a freshly built one) into a complete asset:
 * every field present, dates revived from ISO strings, arrays never undefined.
 *
 * DynamoDB stores whatever it is given and has no schema, so this is the single
 * place that guarantees the shape the rest of the app relies on.
 */
export function normalizeAsset(raw: Record<string, unknown>): AssetRaw {
  const dep = (raw.depreciation ?? {}) as Record<string, unknown>;
  const emp = (raw.assignedEmployee ?? {}) as Record<string, unknown>;
  const war = (raw.warranty ?? {}) as Record<string, unknown>;
  const ver = (raw.physicalVerification ?? {}) as Record<string, unknown>;

  return {
    assetCode: str(raw.assetCode),
    entity: str(raw.entity),
    photo: asFile(raw.photo),

    product: str(raw.product),
    category: str(raw.category),
    brand: str(raw.brand),
    productNumber: str(raw.productNumber),

    purchaseDate: asDate(raw.purchaseDate),
    paymentDate: asDate(raw.paymentDate),
    purchaseInvoices: fileList(raw.purchaseInvoices, raw.purchaseInvoice),
    invoiceNumber: str(raw.invoiceNumber),
    vendor: str(raw.vendor),
    purchaseCost: num(raw.purchaseCost),

    depreciation: {
      method: str(dep.method) || "SLM",
      ratePercent: num(dep.ratePercent),
      usefulLifeYears: num(dep.usefulLifeYears),
      salvageValue: num(dep.salvageValue),
    },

    assignedEmployee: {
      name: str(emp.name),
      employeeId: str(emp.employeeId),
      email: str(emp.email),
    },
    department: str(raw.department),
    location: str(raw.location),

    serviceRecords: asArray(raw.serviceRecords).map((r) => ({
      _id: str(r._id) || newId(),
      description: str(r.description),
      purchaseDate: asDate(r.purchaseDate),
      serviceDate: asDate(r.serviceDate),
      paymentDate: asDate(r.paymentDate),
      purchaseCost: num(r.purchaseCost),
      serviceCost: num(r.serviceCost),
      invoiceNumber: str(r.invoiceNumber),
      vendor: str(r.vendor),
      warrantyPeriod: str(r.warrantyPeriod),
      photo: asFile(r.photo),
    })),

    warranty: {
      provider: str(war.provider),
      expiryDate: asDate(war.expiryDate),
      documents: fileList(war.documents, war.document),
    },

    physicalVerification: {
      verified: ver.verified === true || ver.verified === "true",
      verifiedOn: asDate(ver.verifiedOn),
      verifiedBy: str(ver.verifiedBy),
      remarks: str(ver.remarks),
      photo: asFile(ver.photo),
    },

    transferHistory: asArray(raw.transferHistory).map((t) => ({
      _id: str(t._id) || newId(),
      date: asDate(t.date),
      fromEmployee: str(t.fromEmployee),
      toEmployee: str(t.toEmployee),
      fromDepartment: str(t.fromDepartment),
      toDepartment: str(t.toDepartment),
      fromLocation: str(t.fromLocation),
      toLocation: str(t.toLocation),
      remarks: str(t.remarks),
    })),

    status: (ASSET_STATUSES as readonly string[]).includes(str(raw.status))
      ? str(raw.status)
      : "Active",
    notes: str(raw.notes),

    createdAt: asDate(raw.createdAt) ?? new Date(),
    updatedAt: asDate(raw.updatedAt) ?? new Date(),
  };
}

/**
 * Everything the search box looks at, lowercased into one attribute.
 *
 * DynamoDB's `contains()` is case-sensitive and cannot span attributes, so the
 * searchable text is denormalised on write. That is what lets the search run in
 * the database instead of in Node.
 */
export function buildSearchText(asset: AssetRaw): string {
  return [
    asset.assetCode,
    asset.product,
    asset.productNumber,
    asset.brand,
    asset.invoiceNumber,
    asset.vendor,
    asset.assignedEmployee.name,
    asset.assignedEmployee.employeeId,
    asset.department,
    asset.location,
    asset.category,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** Turns an asset into the plain item DynamoDB stores (Dates become ISO strings). */
export function toItem(asset: AssetRaw): Record<string, unknown> {
  const item = JSON.parse(JSON.stringify(asset)) as Record<string, unknown>;
  item.searchText = buildSearchText(asset);
  return item;
}

/**
 * FA codes are only unique within a company, so the record is identified by both.
 * `~` never appears in an entity name, and the split takes the FIRST one, so a
 * code containing `~` still parses correctly.
 */
export const ID_SEPARATOR = "~";

export const makeId = (entity: string, assetCode: string): string =>
  `${entity}${ID_SEPARATOR}${assetCode}`;

export function parseId(id: string): { entity: string; assetCode: string } {
  const at = id.indexOf(ID_SEPARATOR);
  if (at < 0) return { entity: "", assetCode: id.trim().toUpperCase() };
  return {
    entity: id.slice(0, at).trim().toUpperCase(),
    assetCode: id.slice(at + 1).trim().toUpperCase(),
  };
}

/**
 * The API response shape. `_id` is the composite key so the frontend keeps using
 * a single opaque identifier for routes and links.
 */
export function toApi<T extends AssetRaw>(
  asset: T
): T & {
  _id: string;
  id: string;
  purchaseInvoice: StoredFileDoc | null;
  warranty: T["warranty"] & { document: StoredFileDoc | null };
} {
  const id = makeId(asset.entity, asset.assetCode);
  // The singular forms are derived, not stored: anything that wants one file
  // (PDF, Excel, the old detail rows) reads these rather than indexing arrays.
  return {
    ...asset,
    _id: id,
    id,
    purchaseInvoice: asset.purchaseInvoices[0] ?? null,
    warranty: { ...asset.warranty, document: asset.warranty.documents[0] ?? null },
  };
}
