import type { Request, Response } from "express";
import {
  GST_MODES,
  PO_ITEM_KINDS,
  PO_STATUSES,
  newId,
  normalizePurchaseOrder,
  parseId,
  toApi,
  type PoItemDoc,
  type PoItemKind,
  type PurchaseOrderRaw,
} from "../models/PurchaseOrder";
import { ENTITIES, type StoredFileDoc } from "../models/Asset";
import { buyerProfile, type PartyDoc } from "../constants/parties";
import * as repo from "../repositories/purchaseOrderRepository";
import { ApiError } from "../middleware/errorHandler";
import { destroyFile, uploadBuffer } from "../utils/cloudinaryUpload";
import { buildPurchaseOrderWorkbook } from "../utils/poExcel";
import { buildPurchaseOrderPdf } from "../utils/poPdf";
import { sendPurchaseOrderEmail } from "../utils/mailer";
import { syncVendorFromSupplier } from "../utils/vendorSync";
import { extractPurchaseOrderFromPdf } from "../utils/pdfExtract";
import { EXTRACTABLE_TYPES } from "../utils/geminiDoc";
import { financialYear, nextPoNumber } from "../utils/poNumber";
import { MAX_DOCS, type UploadedFiles } from "../middleware/upload";

/** How many lines one order may carry — a guard, not a business rule. */
const MAX_ITEMS = 200;

/* ------------------------------------------------------------------ */
/* Input helpers                                                       */
/* ------------------------------------------------------------------ */

/** Nested objects arrive as JSON strings over multipart/form-data. */
function parseJSON<T>(value: unknown, fallback: T): T {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "object") return value as T;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toDate(value: unknown): Date | null {
  if (!value) return null;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d;
}

const trim = (value: unknown): string => String(value ?? "").trim();

/**
 * The "what do they supply" tags typed on the Supplier section - not part of
 * the order itself, so they never land on `PurchaseOrderRaw`. They exist only
 * to be handed to `syncVendorFromSupplier` after the order is saved.
 */
function supplierSupplyTags(body: Record<string, unknown>): string[] {
  const raw = parseJSON<string[]>(body.supplierSuppliesTags, []);
  return Array.from(new Set(raw.map((t) => trim(t)).filter(Boolean)));
}

/**
 * The category typed for a brand-new supplier on the Supplier section - same
 * deal as the tags above: not part of the order, only used to categorise a
 * vendor `syncVendorFromSupplier` is about to create.
 */
function supplierCategory(body: Record<string, unknown>): string {
  return trim(body.supplierCategory);
}

/**
 * The route param is the composite "entity~poNumber" id, percent-encoded in the
 * URL. A bare number is still accepted and resolved by searching, so a
 * hand-typed URL keeps working.
 */
function idParam(req: Request): string {
  const raw = String(req.params.id ?? "");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

async function loadOr404(req: Request): Promise<PurchaseOrderRaw> {
  const key = parseId(idParam(req));

  if (key.entity) {
    const po = await repo.getByKey(key);
    if (!po) throw new ApiError(404, "Purchase order not found");
    return po;
  }

  const matches = (await repo.queryOrders({ search: key.poNumber })).filter(
    (p) => p.poNumber === key.poNumber
  );
  if (matches.length === 0) throw new ApiError(404, "Purchase order not found");
  if (matches.length > 1) {
    throw new ApiError(
      400,
      `PO number ${key.poNumber} exists for more than one company — use the full link`
    );
  }
  return matches[0]!;
}

function asParty(value: unknown): PartyDoc {
  const p = parseJSON(value, {} as Record<string, unknown>);
  return {
    name: trim(p.name),
    address: trim(p.address),
    gstNumber: trim(p.gstNumber).toUpperCase(),
  };
}

/**
 * Rebuilds the order lines from the form.
 *
 * Amounts are never taken from the request — they are recomputed from quantity
 * and price on read, so a client cannot post a total that disagrees with its own
 * grid.
 */
function buildItems(body: Record<string, unknown>): PoItemDoc[] {
  const rows = parseJSON<Record<string, unknown>[]>(body.items, []).filter(
    (r) => r && typeof r === "object"
  );

  if (rows.length > MAX_ITEMS) {
    throw new ApiError(400, `A purchase order can hold at most ${MAX_ITEMS} lines`);
  }

  return rows.map((row) => {
    const raw = trim(row.kind);
    const kind: PoItemKind = (PO_ITEM_KINDS as readonly string[]).includes(raw)
      ? (raw as PoItemKind)
      : "item";
    const heading = kind === "heading";
    return {
      _id: trim(row._id) || newId(),
      kind,
      name: trim(row.name),
      description: trim(row.description),
      hsnCode: trim(row.hsnCode),
      // A heading names a group; carrying a quantity or rate on it would double
      // count against the lines beneath.
      quantity: heading ? 0 : toNumber(row.quantity),
      unit: heading ? "" : trim(row.unit),
      price: heading ? 0 : toNumber(row.price),
    };
  });
}

function buildPayload(body: Record<string, unknown>) {
  const entity = (ENTITIES as readonly string[]).includes(trim(body.entity))
    ? trim(body.entity)
    : "";

  const supplier = asParty(body.supplier);
  const supplierExtra = parseJSON(body.supplier, {} as Record<string, unknown>);

  // The buyer and delivery blocks default to the entity's own profile, so a PO
  // raised with the form untouched still prints a complete header.
  const profile = buyerProfile(entity);
  const buyer = asParty(body.buyer);
  const deliverTo = asParty(body.deliverTo);

  return {
    entity,
    poNumber: trim(body.poNumber),
    poDate: toDate(body.poDate),
    buyer: buyer.name ? buyer : profile,
    supplier: {
      ...supplier,
      contactPerson: trim(supplierExtra.contactPerson),
      phone: trim(supplierExtra.phone),
      email: trim(supplierExtra.email).toLowerCase(),
    },
    deliverTo: deliverTo.name ? deliverTo : buyer.name ? buyer : profile,
    vendorCode: trim(body.vendorCode),
    currency: trim(body.currency).toUpperCase() || "INR",
    supplierRef: trim(body.supplierRef),
    otherReference: trim(body.otherReference),
    paymentTerms: trim(body.paymentTerms),
    project: trim(body.project),
    purchasingGroup: trim(body.purchasingGroup),
    items: buildItems(body),
    discount: toNumber(body.discount),
    gstPercent: toNumber(body.gstPercent),
    gstMode: (GST_MODES as readonly string[]).includes(trim(body.gstMode))
      ? trim(body.gstMode)
      : "GST",
    status: (PO_STATUSES as readonly string[]).includes(trim(body.status))
      ? trim(body.status)
      : "Draft",
    expectedDate: toDate(body.expectedDate),
    department: trim(body.department),
    requestedBy: trim(body.requestedBy),
    approvedBy: trim(body.approvedBy),
    terms: parseJSON<string[]>(body.terms, [])
      .map((t) => String(t ?? "").trim())
      .filter(Boolean),
    notes: trim(body.notes),
  };
}

/**
 * The contact person, phone and per-line HSN/SAC checks are `strict`-only, so
 * only *creating* a new order enforces them — an older order saved before this
 * rule existed can still be edited and re-saved without being forced to
 * backfill data that didn't used to be asked for.
 */
function assertRequired(
  payload: {
    entity: string;
    poNumber: string;
    supplier: { name: string; contactPerson: string; phone: string };
    items: PoItemDoc[];
  },
  opts: { strict?: boolean } = {}
): void {
  if (!payload.poNumber) throw new ApiError(400, "PO number is required");
  if (!payload.entity) throw new ApiError(400, "Entity is required (ENP or GCC)");
  if (!payload.supplier.name) throw new ApiError(400, "Supplier name is required");
  if (opts.strict && !payload.supplier.contactPerson) {
    throw new ApiError(400, "Supplier contact person is required");
  }
  if (opts.strict && !payload.supplier.phone) {
    throw new ApiError(400, "Supplier phone number is required");
  }
  if (!payload.items.some((i) => i.kind !== "heading")) {
    throw new ApiError(400, "Add at least one priced line to the order");
  }
  if (opts.strict && payload.items.some((i) => i.kind !== "heading" && !i.hsnCode)) {
    throw new ApiError(400, "Add an HSN/SAC code for every item");
  }
}

/**
 * Rebuilds the attachment list.
 *
 * The form echoes back the publicIds it wants to keep, in display order; the file
 * objects are looked up on the stored record rather than trusted from the
 * request, so a client cannot point a record at an arbitrary URL.
 */
async function buildAttachments(
  body: Record<string, unknown>,
  files: UploadedFiles | undefined,
  existing: StoredFileDoc[] = []
): Promise<{ list: StoredFileDoc[]; stale: StoredFileDoc[] }> {
  const storedById = new Map(existing.filter((f) => f.publicId).map((f) => [f.publicId, f]));

  const raw = body.attachmentIds;
  const keepIds = parseJSON<string[]>(raw, []).filter((id) => typeof id === "string");

  // An absent list means "leave attachments alone".
  const kept =
    raw === undefined
      ? existing
      : keepIds.map((id) => storedById.get(id)).filter((f): f is StoredFileDoc => !!f);

  const uploaded = await Promise.all(
    (files?.attachment ?? []).map((f) => uploadBuffer(f, "purchase-orders"))
  );

  const list = [...kept, ...uploaded];
  if (list.length > MAX_DOCS) {
    throw new ApiError(400, `At most ${MAX_DOCS} attachments per order`);
  }

  const keptIds = new Set(kept.map((f) => f.publicId));
  return { list, stale: existing.filter((f) => f.publicId && !keptIds.has(f.publicId)) };
}

/* ------------------------------------------------------------------ */
/* Query -> sort / page                                                */
/* ------------------------------------------------------------------ */

const SORTABLE = new Set([
  "createdAt",
  "poNumber",
  "poDate",
  "expectedDate",
  "status",
  "entity",
  "grandTotal",
  "department",
]);

function sortValue(po: PurchaseOrderRaw, field: string): unknown {
  // Order value is derived, so it is not an attribute on the record itself.
  if (field === "grandTotal") return toApi(po).totals.grandTotal;
  if (field === "supplier") return po.supplier.name;
  return (po as unknown as Record<string, unknown>)[field];
}

function applySort(
  orders: PurchaseOrderRaw[],
  query: Record<string, string | undefined>
): PurchaseOrderRaw[] {
  const field = SORTABLE.has(query.sortBy ?? "") ? query.sortBy! : "createdAt";
  const dir = query.sortOrder === "asc" ? 1 : -1;

  return [...orders].sort((a, b) => {
    const av = sortValue(a, field);
    const bv = sortValue(b, field);

    // Missing values always sort last, whichever direction was asked for.
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;

    if (av instanceof Date && bv instanceof Date) return (av.getTime() - bv.getTime()) * dir;
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
}

async function loadFor(
  query: Record<string, string | undefined>
): Promise<PurchaseOrderRaw[]> {
  return repo.queryOrders({
    search: query.search,
    status: query.status,
    entity: query.entity,
    supplier: query.supplier,
    department: query.department,
    dateFrom: query.dateFrom,
    dateTo: query.dateTo,
  });
}

/* ------------------------------------------------------------------ */
/* GET /api/purchase-orders                                            */
/* ------------------------------------------------------------------ */
export async function listPurchaseOrders(req: Request, res: Response): Promise<void> {
  const query = req.query as Record<string, string | undefined>;
  const page = Math.max(1, toNumber(query.page, 1));
  const limit = Math.min(100, Math.max(1, toNumber(query.limit, 20)));

  const matched = applySort(await loadFor(query), query);
  const total = matched.length;
  const start = (page - 1) * limit;

  res.json({
    success: true,
    data: matched.slice(start, start + limit).map(toApi),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      from: total === 0 ? 0 : start + 1,
      to: Math.min(start + limit, total),
    },
  });
}

/* ------------------------------------------------------------------ */
/* GET /api/purchase-orders/:id                                        */
/* ------------------------------------------------------------------ */
export async function getPurchaseOrder(req: Request, res: Response): Promise<void> {
  const po = await loadOr404(req);
  res.json({ success: true, data: toApi(po) });
}

/* ------------------------------------------------------------------ */
/* POST /api/purchase-orders                                           */
/* ------------------------------------------------------------------ */
export async function createPurchaseOrder(req: Request, res: Response): Promise<void> {
  const files = req.files as UploadedFiles | undefined;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const payload = buildPayload(body);

  assertRequired(payload, { strict: true });

  // Cheap pre-check so an obvious duplicate does not pay for uploads first; the
  // conditional write in the repository is what actually guarantees uniqueness.
  if (await repo.exists({ entity: payload.entity, poNumber: payload.poNumber })) {
    throw new ApiError(
      409,
      `PO number ${payload.poNumber} is already in use for ${payload.entity}`
    );
  }

  const attachments = await buildAttachments(body, files);

  const now = new Date();
  const po = normalizePurchaseOrder({
    ...payload,
    attachments: attachments.list,
    createdAt: now,
    updatedAt: now,
  });

  await repo.create(po);

  // Best-effort: never lets a vendor-sync hiccup fail the PO that was just
  // created.
  await syncVendorFromSupplier(po.supplier, supplierSupplyTags(body), po.vendorCode, supplierCategory(body));

  res
    .status(201)
    .json({ success: true, message: "Purchase order created", data: toApi(po) });
}

/* ------------------------------------------------------------------ */
/* PUT /api/purchase-orders/:id                                        */
/* ------------------------------------------------------------------ */
export async function updatePurchaseOrder(req: Request, res: Response): Promise<void> {
  const existing = await loadOr404(req);

  const files = req.files as UploadedFiles | undefined;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const payload = buildPayload(body);

  assertRequired(payload);

  // entity and poNumber are both key attributes, so changing either relocates
  // the record rather than updating it in place.
  const keyChanged =
    payload.poNumber !== existing.poNumber || payload.entity !== existing.entity;
  if (
    keyChanged &&
    (await repo.exists({ entity: payload.entity, poNumber: payload.poNumber }))
  ) {
    throw new ApiError(
      409,
      `PO number ${payload.poNumber} is already in use for ${payload.entity}`
    );
  }

  const attachments = await buildAttachments(body, files, existing.attachments);

  const po = normalizePurchaseOrder({
    ...payload,
    attachments: attachments.list,
    createdAt: existing.createdAt,
    updatedAt: new Date(),
  });

  if (keyChanged) {
    await repo.move({ entity: existing.entity, poNumber: existing.poNumber }, po);
  } else {
    await repo.replace(po);
  }

  // Files dropped from the order are deleted only after the write succeeds.
  await Promise.all(attachments.stale.map((f) => destroyFile(f.publicId, f.resourceType)));

  await syncVendorFromSupplier(po.supplier, supplierSupplyTags(body), po.vendorCode, supplierCategory(body));

  res.json({ success: true, message: "Purchase order updated", data: toApi(po) });
}

/* ------------------------------------------------------------------ */
/* PATCH /api/purchase-orders/:id/status                               */
/* ------------------------------------------------------------------ */
export async function setPurchaseOrderStatus(req: Request, res: Response): Promise<void> {
  const existing = await loadOr404(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const status = trim(body.status);

  if (!(PO_STATUSES as readonly string[]).includes(status)) {
    throw new ApiError(400, `Unknown status "${status}"`);
  }

  const po = normalizePurchaseOrder({ ...existing, status, updatedAt: new Date() });
  await repo.replace(po);

  res.json({ success: true, message: `Marked ${status}`, data: toApi(po) });
}

/* ------------------------------------------------------------------ */
/* DELETE /api/purchase-orders/:id                                     */
/* ------------------------------------------------------------------ */
export async function deletePurchaseOrder(req: Request, res: Response): Promise<void> {
  const po = await loadOr404(req);

  await repo.remove({ entity: po.entity, poNumber: po.poNumber });
  await Promise.all(po.attachments.map((f) => destroyFile(f.publicId, f.resourceType)));

  res.json({ success: true, message: `Purchase order ${po.poNumber} deleted` });
}

/* ------------------------------------------------------------------ */
/* GET /api/purchase-orders/:id/pdf                                    */
/* ------------------------------------------------------------------ */
export async function getPurchaseOrderPdf(req: Request, res: Response): Promise<void> {
  const po = await loadOr404(req);

  const pdf = await buildPurchaseOrderPdf(toApi(po));
  const safe = (po.poNumber || "purchase-order").replace(/[^A-Za-z0-9._-]/g, "-");

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="PO-${safe}.pdf"`);
  res.setHeader("Content-Length", String(pdf.length));
  res.send(pdf);
}

/* ------------------------------------------------------------------ */
/* POST /api/purchase-orders/:id/email                                 */
/* ------------------------------------------------------------------ */

/**
 * Emails the order's PDF to its supplier, from the buying company's own
 * mailbox (onerootoffice@oneroot.farm for ENP, accounts@goldcoinsresort.in for
 * GCC). A deliberate, on-demand action — nothing sends a PO to a vendor on its
 * own.
 */
export async function emailPurchaseOrder(req: Request, res: Response): Promise<void> {
  const po = await loadOr404(req);
  const api = toApi(po);

  const pdf = await buildPurchaseOrderPdf(api);
  const { to, from } = await sendPurchaseOrderEmail(api, pdf);

  res.json({ success: true, message: `PO ${po.poNumber} emailed to ${to}`, data: { to, from } });
}

/* ------------------------------------------------------------------ */
/* GET /api/purchase-orders/export                                     */
/* ------------------------------------------------------------------ */
export async function exportPurchaseOrders(req: Request, res: Response): Promise<void> {
  const query = req.query as Record<string, string | undefined>;
  const matched = applySort(await loadFor(query), query);

  const workbook = await buildPurchaseOrderWorkbook(matched.map(toApi));

  const now = new Date();
  const stamp = [
    String(now.getDate()).padStart(2, "0"),
    String(now.getMonth() + 1).padStart(2, "0"),
    now.getFullYear(),
  ].join("-");

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="purchase-orders-${stamp}.xlsx"`
  );
  res.setHeader("Content-Length", String(workbook.length));
  res.send(workbook);
}

/* ------------------------------------------------------------------ */
/* GET /api/purchase-orders/meta/next-number                           */
/* ------------------------------------------------------------------ */

/**
 * Suggests the next PO number for one company.
 *
 * The read is scoped to that company's partition, so the two series stay
 * genuinely independent: asking for GCC's next number never looks at, and never
 * advances, ENP's.
 *
 * This only *suggests*. Nothing is reserved until the order is saved, and the
 * conditional write in the repository is what actually settles a race between
 * two people filling the form at once.
 */
export async function getNextPoNumber(req: Request, res: Response): Promise<void> {
  const query = req.query as Record<string, string | undefined>;
  const entity = trim(query.entity).toUpperCase();

  if (!(ENTITIES as readonly string[]).includes(entity)) {
    throw new ApiError(400, "Pick the company first (ENP or GCC)");
  }

  const fy = financialYear(toDate(query.date) ?? new Date());
  const orders = await repo.queryOrders({ entity });
  const next = nextPoNumber(
    orders.map((o) => o.poNumber),
    fy
  );

  res.json({ success: true, data: { ...next, entity } });
}

/* ------------------------------------------------------------------ */
/* POST /api/purchase-orders/meta/extract-pdf                          */
/* ------------------------------------------------------------------ */

/**
 * Reads an uploaded vendor quotation/invoice/old-PO - a PDF or a photo/scan
 * of one - and returns fields to pre-fill the New PO form with. Nothing is
 * saved here - this only reads a file and hands back suggestions; the order
 * is still created through the normal POST, same validation and all.
 */
export async function extractPurchaseOrderPdf(req: Request, res: Response): Promise<void> {
  const file = req.file as Express.Multer.File | undefined;
  if (!file) throw new ApiError(400, "Attach a PDF or photo to import from");
  if (!EXTRACTABLE_TYPES.has(file.mimetype)) {
    throw new ApiError(400, "Only PDF or image files (JPG, PNG, WEBP, HEIC) are supported");
  }

  const data = await extractPurchaseOrderFromPdf(file.buffer, file.mimetype);
  res.json({ success: true, data });
}

/* ------------------------------------------------------------------ */
/* GET /api/purchase-orders/meta/options                               */
/* ------------------------------------------------------------------ */
export async function getPoFilterOptions(_req: Request, res: Response): Promise<void> {
  const orders = await repo.getAll();

  const distinct = (pick: (p: PurchaseOrderRaw) => string) =>
    Array.from(new Set(orders.map(pick).map((v) => v.trim()).filter(Boolean))).sort((a, b) =>
      a.localeCompare(b)
    );

  res.json({
    success: true,
    data: {
      statuses: [...PO_STATUSES],
      entities: [...ENTITIES],
      gstModes: [...GST_MODES],
      suppliers: distinct((p) => p.supplier.name),
      departments: distinct((p) => p.department),
      requesters: distinct((p) => p.requestedBy),
      projects: distinct((p) => p.project),
      purchasingGroups: distinct((p) => p.purchasingGroup),
      units: distinct((p) => p.items.map((i) => i.unit).find(Boolean) ?? ""),
      /** Every buyer block already used, so a new PO can reuse one verbatim. */
      buyers: Object.fromEntries(
        Array.from(new Set(orders.map((p) => p.entity))).map((entity) => [
          entity,
          orders.find((p) => p.entity === entity)?.buyer ?? buyerProfile(entity),
        ])
      ),
    },
  });
}

/* ------------------------------------------------------------------ */
/* GET /api/purchase-orders/meta/stats                                 */
/* ------------------------------------------------------------------ */
export async function getPoStats(_req: Request, res: Response): Promise<void> {
  const orders = await repo.getAll();

  let totalValue = 0;
  let openValue = 0;
  let openCount = 0;

  const statusCounts: Record<string, number> = Object.fromEntries(
    PO_STATUSES.map((s) => [s, 0])
  );
  const bySupplierMap = new Map<string, { count: number; value: number }>();
  const byEntityMap = new Map<string, { count: number; value: number }>();
  const monthlyMap = new Map<string, { count: number; value: number }>();

  const bump = (
    map: Map<string, { count: number; value: number }>,
    key: string,
    value: number
  ) => {
    if (!key) return;
    const cur = map.get(key) ?? { count: 0, value: 0 };
    cur.count += 1;
    cur.value += value;
    map.set(key, cur);
  };

  for (const po of orders) {
    const value = toApi(po).totals.grandTotal;
    totalValue += value;

    statusCounts[String(po.status)] = (statusCounts[String(po.status)] ?? 0) + 1;

    // "Open" is anything still owed to us: raised but not fully received, and
    // not cancelled.
    if (po.status !== "Received" && po.status !== "Cancelled") {
      openValue += value;
      openCount += 1;
    }

    bump(bySupplierMap, po.supplier.name, value);
    bump(byEntityMap, po.entity, value);

    if (po.poDate) {
      const key = `${po.poDate.getFullYear()}-${String(po.poDate.getMonth() + 1).padStart(2, "0")}`;
      bump(monthlyMap, key, value);
    }
  }

  const topBy = (map: Map<string, { count: number; value: number }>, limit: number) =>
    Array.from(map, ([name, v]) => ({ name, count: v.count, value: v.value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, limit);

  const round2 = (n: number) => Math.round(n * 100) / 100;

  res.json({
    success: true,
    data: {
      totalOrders: orders.length,
      totalValue: round2(totalValue),
      openOrders: openCount,
      openValue: round2(openValue),
      statusCounts,
      byStatus: Object.entries(statusCounts).map(([name, count]) => ({ name, count })),
      bySupplier: topBy(bySupplierMap, 8),
      byEntity: topBy(byEntityMap, 10),
      monthly: Array.from(monthlyMap, ([month, v]) => ({
        month,
        count: v.count,
        value: round2(v.value),
      }))
        .sort((a, b) => a.month.localeCompare(b.month))
        .slice(-24),
    },
  });
}
