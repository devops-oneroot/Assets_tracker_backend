import { randomUUID } from "crypto";
import type { PartyDoc } from "../constants/parties";
import { asDate, type StoredFileDoc } from "./Asset";

/** Where a PO is in its life: raised, sent out, approved, received, cancelled. */
export const PO_STATUSES = [
  "Draft",
  "Sent",
  "Approved",
  "Partially Received",
  "Received",
  "Cancelled",
] as const;
export type PoStatus = (typeof PO_STATUSES)[number];

/**
 * How the tax line is presented on the printed order.
 *
 * "GST" prints a single combined line, matching the format already in use. The
 * split modes are for when the document has to show the components: CGST+SGST
 * within the state, IGST for a supplier outside it.
 */
export const GST_MODES = ["GST", "CGST+SGST", "IGST"] as const;
export type GstMode = (typeof GST_MODES)[number];

/** What the unit column offers. Free text is accepted too. */
export const PO_UNITS = [
  "NOS",
  "Lot",
  "Set",
  "Box",
  "Pkt",
  "Kg",
  "Ltr",
  "Mtr",
  "RMT",
  "SQFT",
  "Hrs",
  "Days",
] as const;

/**
 * What a row of the grid is.
 *
 * "heading" names a group ("Kitchen Wood") and carries no money; "sub" is a
 * priced member of the group above it; "item" is a priced row standing on its
 * own. Together they produce the 1 / a / b / c / 2 / 3 numbering the existing
 * orders use, which cannot be inferred from position alone - a plain item after
 * a group has to be able to end that group.
 */
export const PO_ITEM_KINDS = ["item", "heading", "sub"] as const;
export type PoItemKind = (typeof PO_ITEM_KINDS)[number];

export interface PoItemDoc {
  _id: string;
  kind: PoItemKind;
  name: string;
  description: string;
  hsnCode: string;
  quantity: number;
  unit: string;
  price: number;
}

export interface SupplierDoc extends PartyDoc {
  contactPerson: string;
  phone: string;
  email: string;
}

export interface PurchaseOrderRaw {
  /** Buying company — the DynamoDB partition key. */
  entity: string;
  /** PO number as printed, e.g. "049/2025-26" — the sort key. */
  poNumber: string;
  poDate: Date | null;

  /** Buyer block, copied from the entity profile when the PO is raised. */
  buyer: PartyDoc;
  supplier: SupplierDoc;
  /** Where the goods go. Usually the buyer's own address. */
  deliverTo: PartyDoc;

  /** The supplier's own code in the buyer's vendor master, if one exists. */
  vendorCode: string;
  /** ISO currency the order is priced in — "INR" unless stated otherwise. */
  currency: string;
  /** The supplier's own quotation reference, and anything else being cited. */
  supplierRef: string;
  otherReference: string;
  /** How the vendor gets paid, printed as its own header field, e.g. "50% advance, 50% on delivery". */
  paymentTerms: string;
  /** The job or contract this order is raised against, e.g. "Construction of Warehouse". */
  project: string;
  /** The buying team that raised the order, e.g. "ENP / PROJECTS". */
  purchasingGroup: string;

  items: PoItemDoc[];

  /** Flat discount off the line total, in rupees. */
  discount: number;
  gstPercent: number;
  gstMode: GstMode | string;

  status: PoStatus | string;
  expectedDate: Date | null;
  department: string;
  requestedBy: string;
  approvedBy: string;

  /** Numbered terms printed under the grid. */
  terms: string[];
  notes: string;
  /** Quotes, proposals, signed copies. */
  attachments: StoredFileDoc[];

  createdAt: Date;
  updatedAt: Date;
}

export const newId = (): string => randomUUID();

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n: number): number => Math.round(n * 100) / 100;

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

function asParty(value: unknown): PartyDoc {
  const p = (value ?? {}) as Record<string, unknown>;
  return {
    name: str(p.name),
    address: str(p.address),
    gstNumber: str(p.gstNumber).toUpperCase(),
  };
}

/** Reads a row's kind, falling back to the older `isHeading` boolean. */
function asKind(row: Record<string, unknown>): PoItemKind {
  const kind = str(row.kind);
  if ((PO_ITEM_KINDS as readonly string[]).includes(kind)) return kind as PoItemKind;
  return row.isHeading === true || row.isHeading === "true" ? "heading" : "item";
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? (value.filter((v) => v && typeof v === "object") as Record<string, unknown>[])
    : [];
}

/**
 * Normalises a raw DynamoDB item into a complete purchase order: every field
 * present, dates revived from ISO strings, arrays never undefined.
 *
 * As with assets, DynamoDB has no schema, so this is the single place that
 * guarantees the shape the rest of the app relies on.
 */
export function normalizePurchaseOrder(raw: Record<string, unknown>): PurchaseOrderRaw {
  const sup = (raw.supplier ?? {}) as Record<string, unknown>;

  return {
    entity: str(raw.entity).toUpperCase(),
    poNumber: str(raw.poNumber).trim(),
    poDate: asDate(raw.poDate),

    buyer: asParty(raw.buyer),
    supplier: {
      ...asParty(raw.supplier),
      contactPerson: str(sup.contactPerson),
      phone: str(sup.phone),
      email: str(sup.email).toLowerCase(),
    },
    deliverTo: asParty(raw.deliverTo),

    vendorCode: str(raw.vendorCode),
    currency: str(raw.currency).toUpperCase() || "INR",
    supplierRef: str(raw.supplierRef),
    otherReference: str(raw.otherReference),
    paymentTerms: str(raw.paymentTerms),
    project: str(raw.project),
    purchasingGroup: str(raw.purchasingGroup),

    items: asArray(raw.items).map((i) => ({
      _id: str(i._id) || newId(),
      kind: asKind(i),
      name: str(i.name),
      description: str(i.description),
      hsnCode: str(i.hsnCode),
      quantity: num(i.quantity),
      unit: str(i.unit),
      price: num(i.price),
    })),

    discount: num(raw.discount),
    gstPercent: num(raw.gstPercent),
    gstMode: (GST_MODES as readonly string[]).includes(str(raw.gstMode))
      ? str(raw.gstMode)
      : "GST",

    status: (PO_STATUSES as readonly string[]).includes(str(raw.status))
      ? str(raw.status)
      : "Draft",
    expectedDate: asDate(raw.expectedDate),
    department: str(raw.department),
    requestedBy: str(raw.requestedBy),
    approvedBy: str(raw.approvedBy),

    terms: Array.isArray(raw.terms) ? raw.terms.map(str).filter(Boolean) : [],
    notes: str(raw.notes),
    attachments: Array.isArray(raw.attachments)
      ? raw.attachments.map(asFile).filter((f): f is StoredFileDoc => !!f)
      : [],

    createdAt: asDate(raw.createdAt) ?? new Date(),
    updatedAt: asDate(raw.updatedAt) ?? new Date(),
  };
}

/* ------------------------------------------------------------------ */
/* Derived money                                                       */
/* ------------------------------------------------------------------ */

export interface PoTotals {
  /** Sum of every priced line. Heading rows contribute nothing. */
  subTotal: number;
  discount: number;
  /** What GST is charged on: subTotal less the discount. */
  taxableAmount: number;
  gstAmount: number;
  /** Half of gstAmount each, and 0 unless the mode is CGST+SGST. */
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  grandTotal: number;
  itemCount: number;
}

export const lineAmount = (item: PoItemDoc): number =>
  item.kind === "heading" ? 0 : round2(item.quantity * item.price);

/**
 * Recomputes every figure on the order from the lines up.
 *
 * Nothing here is stored for the document to read back: a total derived from
 * quantities and rates would drift the moment a line was edited, and a PO whose
 * printed total disagrees with its own grid is worse than useless.
 */
export function computeTotals(po: PurchaseOrderRaw): PoTotals {
  const priced = po.items.filter((i) => i.kind !== "heading");
  const subTotal = round2(priced.reduce((sum, i) => sum + lineAmount(i), 0));

  // A discount can never take the order below zero.
  const discount = round2(Math.min(Math.max(0, po.discount), subTotal));
  const taxableAmount = round2(subTotal - discount);
  const gstAmount = round2((taxableAmount * po.gstPercent) / 100);
  const half = round2(gstAmount / 2);

  return {
    subTotal,
    discount,
    taxableAmount,
    gstAmount,
    cgstAmount: po.gstMode === "CGST+SGST" ? half : 0,
    // The second half absorbs any rounding so the two always sum to gstAmount.
    sgstAmount: po.gstMode === "CGST+SGST" ? round2(gstAmount - half) : 0,
    igstAmount: po.gstMode === "IGST" ? gstAmount : 0,
    grandTotal: round2(taxableAmount + gstAmount),
    itemCount: priced.length,
  };
}

/**
 * The printed S.No for each row: a heading takes the next number, the sub-rows
 * beneath it take letters, and a plain item takes the next number and closes the
 * group. A sub-row with no heading above it is treated as a plain item rather
 * than printing a stray "a".
 */
export function itemLabels(items: PoItemDoc[]): string[] {
  let group = 0;
  let letter = 0;
  let openGroup = false;

  return items.map((item) => {
    if (item.kind === "heading") {
      group += 1;
      letter = 0;
      openGroup = true;
      return String(group);
    }
    if (item.kind === "sub" && openGroup) {
      const index = letter;
      letter += 1;
      // a, b, c … then aa, ab if a group ever runs past 26 rows.
      return index < 26
        ? String.fromCharCode(97 + index)
        : `${String.fromCharCode(96 + Math.floor(index / 26))}${String.fromCharCode(
            97 + (index % 26)
          )}`;
    }
    openGroup = false;
    group += 1;
    return String(group);
  });
}

/* ------------------------------------------------------------------ */
/* Storage + API shapes                                                */
/* ------------------------------------------------------------------ */

/** Everything the search box looks at, lowercased into one attribute. */
export function buildSearchText(po: PurchaseOrderRaw): string {
  return [
    po.poNumber,
    po.supplier.name,
    po.supplier.gstNumber,
    po.supplier.contactPerson,
    po.vendorCode,
    po.supplierRef,
    po.otherReference,
    po.project,
    po.purchasingGroup,
    po.department,
    po.requestedBy,
    po.approvedBy,
    ...po.items.map((i) => `${i.name} ${i.description}`),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/**
 * Turns a PO into the plain item DynamoDB stores (Dates become ISO strings).
 *
 * The totals ride along as stored attributes purely so the register can sort and
 * filter on order value in the database. `toApi` recomputes them on read, so a
 * stale copy can never reach the printed document.
 */
export function toItem(po: PurchaseOrderRaw): Record<string, unknown> {
  const item = JSON.parse(JSON.stringify(po)) as Record<string, unknown>;
  const totals = computeTotals(po);
  item.searchText = buildSearchText(po);
  item.subTotal = totals.subTotal;
  item.grandTotal = totals.grandTotal;
  return item;
}

/** PO numbers are only unique within a company, so both identify the record. */
export const ID_SEPARATOR = "~";

export const makeId = (entity: string, poNumber: string): string =>
  `${entity}${ID_SEPARATOR}${poNumber}`;

export function parseId(id: string): { entity: string; poNumber: string } {
  const at = id.indexOf(ID_SEPARATOR);
  if (at < 0) return { entity: "", poNumber: id.trim() };
  return {
    entity: id.slice(0, at).trim().toUpperCase(),
    poNumber: id.slice(at + 1).trim(),
  };
}

export type PoItemApi = PoItemDoc & { label: string; amount: number };

export type PurchaseOrderApi = PurchaseOrderRaw & {
  _id: string;
  id: string;
  totals: PoTotals;
  items: PoItemApi[];
};

/** The API response shape: the stored order plus its derived money and labels. */
export function toApi(po: PurchaseOrderRaw): PurchaseOrderApi {
  const id = makeId(po.entity, po.poNumber);
  const labels = itemLabels(po.items);

  return {
    ...po,
    _id: id,
    id,
    totals: computeTotals(po),
    items: po.items.map((item, i) => ({
      ...item,
      label: labels[i] ?? String(i + 1),
      amount: lineAmount(item),
    })),
  };
}
