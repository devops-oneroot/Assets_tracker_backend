import type { Request, Response } from "express";
import {
  ASSET_STATUSES,
  ENTITIES,
  newId,
  normalizeAsset,
  parseId,
  toApi,
  type AssetRaw,
  type ServiceDoc,
  type StoredFileDoc,
  type TransferDoc,
} from "../models/Asset";
import * as repo from "../repositories/assetRepository";
import { ApiError } from "../middleware/errorHandler";
import { uploadBuffer, destroyFile, type StoredFile } from "../utils/cloudinaryUpload";
import { computeDepreciation } from "../utils/depreciation";
import { withComputed } from "../utils/computed";
import { buildAssetWorkbook } from "../utils/excel";
import { buildAssetInvoice } from "../utils/invoice";
import {
  MAX_SERVICE_PHOTOS,
  SERVICE_PHOTO_FIELD,
  type UploadedFiles,
} from "../middleware/upload";

type AnyFile = { publicId?: string; resourceType?: string } | null | undefined;

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

function isTrue(value: unknown): boolean {
  return value === true || value === "true";
}

/**
 * The route param is the composite "entity~code" id, percent-encoded in the URL.
 * A bare code (no separator) is still accepted and resolved by searching, so old
 * links and hand-typed URLs keep working.
 */
function idParam(req: Request): string {
  const raw = String(req.params.id ?? "");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

async function loadOr404(req: Request): Promise<AssetRaw> {
  const key = parseId(idParam(req));

  if (key.entity) {
    const asset = await repo.getByKey(key);
    if (!asset) throw new ApiError(404, "Asset not found");
    return asset;
  }

  // No company in the id — let DynamoDB find the code across companies.
  const matches = (await repo.queryAssets({ search: key.assetCode })).filter(
    (a) => a.assetCode === key.assetCode
  );
  if (matches.length === 0) throw new ApiError(404, "Asset not found");
  if (matches.length > 1) {
    throw new ApiError(
      400,
      `FA code ${key.assetCode} exists for more than one company — use the full link`
    );
  }
  return matches[0]!;
}

/* ------------------------------------------------------------------ */
/* Form -> asset                                                       */
/* ------------------------------------------------------------------ */

function buildAssetPayload(body: Record<string, unknown>) {
  const depreciation = parseJSON(body.depreciation, {} as Record<string, unknown>);
  const assignedEmployee = parseJSON(body.assignedEmployee, {} as Record<string, unknown>);
  const warranty = parseJSON(body.warranty, {} as Record<string, unknown>);
  const verification = parseJSON(body.physicalVerification, {} as Record<string, unknown>);

  return {
    assetCode: String(body.assetCode ?? "").trim().toUpperCase(),
    entity: (ENTITIES as readonly string[]).includes(String(body.entity))
      ? String(body.entity)
      : "",
    product: String(body.product ?? "").trim(),
    category: String(body.category ?? "").trim(),
    brand: String(body.brand ?? "").trim(),
    productNumber: String(body.productNumber ?? "").trim(),
    purchaseDate: toDate(body.purchaseDate),
    paymentDate: toDate(body.paymentDate),
    invoiceNumber: String(body.invoiceNumber ?? "").trim(),
    vendor: String(body.vendor ?? "").trim(),
    purchaseCost: toNumber(body.purchaseCost),
    depreciation: {
      method: String(depreciation.method ?? "SLM"),
      ratePercent: toNumber(depreciation.ratePercent),
      usefulLifeYears: toNumber(depreciation.usefulLifeYears),
      salvageValue: toNumber(depreciation.salvageValue),
    },
    assignedEmployee: {
      name: String(assignedEmployee.name ?? "").trim(),
      employeeId: String(assignedEmployee.employeeId ?? "").trim(),
      email: String(assignedEmployee.email ?? "").trim().toLowerCase(),
    },
    department: String(body.department ?? "").trim(),
    location: String(body.location ?? "").trim(),
    warranty: {
      provider: String(warranty.provider ?? "").trim(),
      expiryDate: toDate(warranty.expiryDate),
    },
    physicalVerification: {
      verified: isTrue(verification.verified),
      verifiedOn: toDate(verification.verifiedOn),
      verifiedBy: String(verification.verifiedBy ?? "").trim(),
      remarks: String(verification.remarks ?? "").trim(),
    },
    status: (ASSET_STATUSES as readonly string[]).includes(String(body.status))
      ? String(body.status)
      : "Active",
    notes: String(body.notes ?? "").trim(),
  };
}

/** Fields the form must supply on both create and update. */
function assertRequired(payload: { assetCode: string; entity: string; product: string }): void {
  if (!payload.assetCode) throw new ApiError(400, "FA code is required");
  if (!payload.entity) throw new ApiError(400, "Entity is required (ENP or GCC)");
  if (!payload.product) throw new ApiError(400, "Product is required");
}

async function uploadIfPresent(
  files: UploadedFiles | undefined,
  field: string,
  folder: string
): Promise<StoredFile | null> {
  const file = files?.[field]?.[0];
  if (!file) return null;
  return uploadBuffer(file, folder);
}

/**
 * Rebuilds the service rows from the form.
 *
 * A row keeps its existing photo by sending back that photo's publicId; the file
 * object is then looked up on the stored record rather than trusted from the
 * request, so a client cannot point a record at an arbitrary URL. A row with a
 * freshly uploaded `servicePhoto_<index>` file gets that instead.
 */
async function buildServiceRecords(
  body: Record<string, unknown>,
  files: UploadedFiles | undefined,
  existing: ServiceDoc[] = []
): Promise<{ records: ServiceDoc[]; keptPublicIds: Set<string> }> {
  const rows = parseJSON<Record<string, unknown>[]>(body.serviceRecords, []).filter(
    (r) => r && typeof r === "object"
  );

  if (rows.length > MAX_SERVICE_PHOTOS) {
    throw new ApiError(400, `At most ${MAX_SERVICE_PHOTOS} service entries per save`);
  }

  const storedByPublicId = new Map<string, StoredFileDoc>();
  for (const row of existing) {
    if (row.photo?.publicId) storedByPublicId.set(row.photo.publicId, row.photo);
  }

  const keptPublicIds = new Set<string>();

  const records = await Promise.all(
    rows.map(async (row, index): Promise<ServiceDoc> => {
      const uploaded = await uploadIfPresent(files, SERVICE_PHOTO_FIELD(index), "services");

      let photo: StoredFileDoc | null = null;
      if (uploaded) {
        photo = uploaded;
      } else {
        const keepId = String(row.photoPublicId ?? "").trim();
        const stored = keepId ? storedByPublicId.get(keepId) : undefined;
        if (stored) {
          photo = stored;
          keptPublicIds.add(keepId);
        }
      }

      return {
        _id: String(row._id ?? "") || newId(),
        description: String(row.description ?? "").trim(),
        purchaseDate: toDate(row.purchaseDate),
        serviceDate: toDate(row.serviceDate),
        paymentDate: toDate(row.paymentDate),
        purchaseCost: toNumber(row.purchaseCost),
        serviceCost: toNumber(row.serviceCost),
        invoiceNumber: String(row.invoiceNumber ?? "").trim(),
        vendor: String(row.vendor ?? "").trim(),
        warrantyPeriod: String(row.warrantyPeriod ?? "").trim(),
        photo,
      };
    })
  );

  return { records, keptPublicIds };
}

/* ------------------------------------------------------------------ */
/* Query -> in-memory filter / sort                                    */
/* ------------------------------------------------------------------ */

const SORTABLE = new Set([
  "createdAt",
  "assetCode",
  "product",
  "purchaseDate",
  "paymentDate",
  "purchaseCost",
  "status",
  "entity",
  "department",
  "location",
]);

function applySort(assets: AssetRaw[], query: Record<string, string | undefined>): AssetRaw[] {
  const field = SORTABLE.has(query.sortBy ?? "") ? query.sortBy! : "createdAt";
  const dir = query.sortOrder === "asc" ? 1 : -1;

  return [...assets].sort((a, b) => {
    const av = (a as unknown as Record<string, unknown>)[field];
    const bv = (b as unknown as Record<string, unknown>)[field];

    // Missing values always sort last, whichever direction was asked for.
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;

    if (av instanceof Date && bv instanceof Date) return (av.getTime() - bv.getTime()) * dir;
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
}

/**
 * Reads the matching assets, with every filter and the search evaluated by
 * DynamoDB. Only sorting and the page slice happen here — neither can be pushed
 * down without a secondary index per sort column.
 */
async function loadFor(query: Record<string, string | undefined>): Promise<AssetRaw[]> {
  return repo.queryAssets({
    search: query.search,
    status: query.status,
    entity: query.entity,
    department: query.department,
    location: query.location,
    category: query.category,
    product: query.product,
    verified: query.verified,
    dateFrom: query.dateFrom,
    dateTo: query.dateTo,
  });
}

/* ------------------------------------------------------------------ */
/* GET /api/assets                                                     */
/* ------------------------------------------------------------------ */
export async function listAssets(req: Request, res: Response): Promise<void> {
  const query = req.query as Record<string, string | undefined>;
  const page = Math.max(1, toNumber(query.page, 1));
  const limit = Math.min(100, Math.max(1, toNumber(query.limit, 20)));

  const matched = applySort(await loadFor(query), query);
  const total = matched.length;
  const start = (page - 1) * limit;

  res.json({
    success: true,
    data: matched.slice(start, start + limit).map((a) => withComputed(toApi(a))),
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
/* GET /api/assets/:id                                                 */
/* ------------------------------------------------------------------ */
export async function getAsset(req: Request, res: Response): Promise<void> {
  const asset = await loadOr404(req);
  res.json({ success: true, data: withComputed(toApi(asset)) });
}

/* ------------------------------------------------------------------ */
/* POST /api/assets                                                    */
/* ------------------------------------------------------------------ */
export async function createAsset(req: Request, res: Response): Promise<void> {
  const files = req.files as UploadedFiles | undefined;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const payload = buildAssetPayload(body);

  assertRequired(payload);

  // Cheap pre-check so an obvious duplicate does not pay for uploads first; the
  // conditional write in the repository is what actually guarantees uniqueness.
  if (await repo.exists({ entity: payload.entity, assetCode: payload.assetCode })) {
    throw new ApiError(
      409,
      `FA code ${payload.assetCode} is already in use for ${payload.entity}`
    );
  }

  const [photo, purchaseInvoice, warrantyDocument, verificationPhoto] = await Promise.all([
    uploadIfPresent(files, "photo", "photos"),
    uploadIfPresent(files, "purchaseInvoice", "invoices"),
    uploadIfPresent(files, "warrantyDocument", "warranties"),
    uploadIfPresent(files, "verificationPhoto", "verifications"),
  ]);

  const transferHistory: TransferDoc[] = parseJSON<Record<string, unknown>[]>(
    body.transferHistory,
    []
  )
    .filter((t) => t && typeof t === "object")
    .map((t) => ({
      _id: newId(),
      date: toDate(t.date) ?? new Date(),
      fromEmployee: String(t.fromEmployee ?? "").trim(),
      toEmployee: String(t.toEmployee ?? "").trim(),
      fromDepartment: String(t.fromDepartment ?? "").trim(),
      toDepartment: String(t.toDepartment ?? "").trim(),
      fromLocation: String(t.fromLocation ?? "").trim(),
      toLocation: String(t.toLocation ?? "").trim(),
      remarks: String(t.remarks ?? "").trim(),
    }));

  const { records: serviceRecords } = await buildServiceRecords(body, files);

  const now = new Date();
  const asset = normalizeAsset({
    ...payload,
    photo,
    purchaseInvoice,
    transferHistory,
    serviceRecords,
    warranty: { ...payload.warranty, document: warrantyDocument },
    physicalVerification: { ...payload.physicalVerification, photo: verificationPhoto },
    createdAt: now,
    updatedAt: now,
  });

  await repo.create(asset);
  res.status(201).json({ success: true, message: "Asset created", data: toApi(asset) });
}

/* ------------------------------------------------------------------ */
/* PUT /api/assets/:id                                                 */
/* ------------------------------------------------------------------ */
export async function updateAsset(req: Request, res: Response): Promise<void> {
  const existing = await loadOr404(req);

  const files = req.files as UploadedFiles | undefined;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const payload = buildAssetPayload(body);

  assertRequired(payload);

  // entity and assetCode are both key attributes, so changing either relocates
  // the record rather than updating it in place.
  const keyChanged =
    payload.assetCode !== existing.assetCode || payload.entity !== existing.entity;
  if (keyChanged && (await repo.exists({ entity: payload.entity, assetCode: payload.assetCode }))) {
    throw new ApiError(
      409,
      `FA code ${payload.assetCode} is already in use for ${payload.entity}`
    );
  }

  const prevEmployee = existing.assignedEmployee.name;
  const prevDepartment = existing.department;
  const prevLocation = existing.location;
  const custodyChanged =
    prevEmployee !== payload.assignedEmployee.name ||
    prevDepartment !== payload.department ||
    prevLocation !== payload.location;

  const [photo, purchaseInvoice, warrantyDocument, verificationPhoto] = await Promise.all([
    uploadIfPresent(files, "photo", "photos"),
    uploadIfPresent(files, "purchaseInvoice", "invoices"),
    uploadIfPresent(files, "warrantyDocument", "warranties"),
    uploadIfPresent(files, "verificationPhoto", "verifications"),
  ]);

  // Cloudinary files replaced or cleared here, deleted only after the write.
  const stale: AnyFile[] = [];

  let nextPhoto = existing.photo;
  let nextInvoice = existing.purchaseInvoice;
  let nextWarrantyDoc = existing.warranty.document;
  let nextVerificationPhoto = existing.physicalVerification.photo;

  if (isTrue(body.removePhoto)) {
    stale.push(nextPhoto);
    nextPhoto = null;
  }
  if (isTrue(body.removePurchaseInvoice)) {
    stale.push(nextInvoice);
    nextInvoice = null;
  }
  if (isTrue(body.removeWarrantyDocument)) {
    stale.push(nextWarrantyDoc);
    nextWarrantyDoc = null;
  }
  if (isTrue(body.removeVerificationPhoto)) {
    stale.push(nextVerificationPhoto);
    nextVerificationPhoto = null;
  }

  if (photo) {
    stale.push(nextPhoto);
    nextPhoto = photo;
  }
  if (purchaseInvoice) {
    stale.push(nextInvoice);
    nextInvoice = purchaseInvoice;
  }
  if (warrantyDocument) {
    stale.push(nextWarrantyDoc);
    nextWarrantyDoc = warrantyDocument;
  }
  if (verificationPhoto) {
    stale.push(nextVerificationPhoto);
    nextVerificationPhoto = verificationPhoto;
  }

  // Service rows are replaced wholesale; photos no longer referenced are dropped.
  const { records: serviceRecords, keptPublicIds } = await buildServiceRecords(
    body,
    files,
    existing.serviceRecords
  );
  for (const row of existing.serviceRecords) {
    const id = row.photo?.publicId;
    if (id && !keptPublicIds.has(id)) stale.push(row.photo);
  }

  const transferHistory = [...existing.transferHistory];
  if (custodyChanged) {
    transferHistory.push({
      _id: newId(),
      date: new Date(),
      fromEmployee: prevEmployee,
      toEmployee: payload.assignedEmployee.name,
      fromDepartment: prevDepartment,
      toDepartment: payload.department,
      fromLocation: prevLocation,
      toLocation: payload.location,
      remarks: String(body.transferRemarks ?? "Updated via asset form"),
    });
  }

  const asset = normalizeAsset({
    ...payload,
    photo: nextPhoto,
    purchaseInvoice: nextInvoice,
    serviceRecords,
    transferHistory,
    warranty: { ...payload.warranty, document: nextWarrantyDoc },
    physicalVerification: {
      ...payload.physicalVerification,
      photo: nextVerificationPhoto,
    },
    createdAt: existing.createdAt,
    updatedAt: new Date(),
  });

  if (keyChanged) {
    await repo.move({ entity: existing.entity, assetCode: existing.assetCode }, asset);
  } else {
    await repo.replace(asset);
  }

  await Promise.all(
    stale.filter(Boolean).map((f) => destroyFile(f!.publicId, f!.resourceType))
  );

  res.json({ success: true, message: "Asset updated", data: toApi(asset) });
}

/* ------------------------------------------------------------------ */
/* DELETE /api/assets/:id                                              */
/* ------------------------------------------------------------------ */
export async function deleteAsset(req: Request, res: Response): Promise<void> {
  const asset = await loadOr404(req);

  const files: AnyFile[] = [
    asset.photo,
    asset.purchaseInvoice,
    asset.warranty.document,
    asset.physicalVerification.photo,
    ...asset.serviceRecords.map((r) => r.photo),
  ];

  await repo.remove({ entity: asset.entity, assetCode: asset.assetCode });
  await Promise.all(
    files.filter(Boolean).map((f) => destroyFile(f!.publicId, f!.resourceType))
  );

  res.json({ success: true, message: `Asset ${asset.assetCode} deleted` });
}

/* ------------------------------------------------------------------ */
/* POST /api/assets/:id/service                                        */
/* ------------------------------------------------------------------ */
export async function addServiceRecord(req: Request, res: Response): Promise<void> {
  const existing = await loadOr404(req);

  const body = (req.body ?? {}) as Record<string, unknown>;
  const file = (req.files as UploadedFiles | undefined)?.photo?.[0];
  const photo = file ? await uploadBuffer(file, "services") : null;

  const entry: ServiceDoc = {
    _id: newId(),
    description: String(body.description ?? "").trim(),
    purchaseDate: toDate(body.purchaseDate),
    serviceDate: toDate(body.serviceDate),
    paymentDate: toDate(body.paymentDate),
    purchaseCost: toNumber(body.purchaseCost),
    serviceCost: toNumber(body.serviceCost),
    invoiceNumber: String(body.invoiceNumber ?? "").trim(),
    vendor: String(body.vendor ?? "").trim(),
    warrantyPeriod: String(body.warrantyPeriod ?? "").trim(),
    photo,
  };

  if (existing.serviceRecords.length >= MAX_SERVICE_PHOTOS) {
    throw new ApiError(400, `An asset can hold at most ${MAX_SERVICE_PHOTOS} service entries`);
  }

  const asset = normalizeAsset({
    ...existing,
    serviceRecords: [...existing.serviceRecords, entry],
    updatedAt: new Date(),
  });

  await repo.replace(asset);
  res.status(201).json({ success: true, message: "Service entry added", data: toApi(asset) });
}

/* ------------------------------------------------------------------ */
/* POST /api/assets/:id/transfer                                       */
/* ------------------------------------------------------------------ */
export async function addTransfer(req: Request, res: Response): Promise<void> {
  const existing = await loadOr404(req);

  const body = (req.body ?? {}) as Record<string, unknown>;
  const toEmployee = String(body.toEmployee ?? "").trim();
  const toDepartment = String(body.toDepartment ?? "").trim();
  const toLocation = String(body.toLocation ?? "").trim();

  const asset = normalizeAsset({
    ...existing,
    // A transfer moves the asset — keep the current-custody fields in sync.
    assignedEmployee: {
      ...existing.assignedEmployee,
      name: toEmployee || existing.assignedEmployee.name,
    },
    department: toDepartment || existing.department,
    location: toLocation || existing.location,
    transferHistory: [
      ...existing.transferHistory,
      {
        _id: newId(),
        date: toDate(body.date) ?? new Date(),
        fromEmployee: existing.assignedEmployee.name,
        toEmployee,
        fromDepartment: existing.department,
        toDepartment,
        fromLocation: existing.location,
        toLocation,
        remarks: String(body.remarks ?? "").trim(),
      },
    ],
    updatedAt: new Date(),
  });

  await repo.replace(asset);
  res.status(201).json({ success: true, message: "Transfer recorded", data: toApi(asset) });
}

/* ------------------------------------------------------------------ */
/* POST /api/assets/:id/verify                                         */
/* ------------------------------------------------------------------ */
export async function verifyAsset(req: Request, res: Response): Promise<void> {
  const existing = await loadOr404(req);

  const body = (req.body ?? {}) as Record<string, unknown>;
  const file = (req.files as UploadedFiles | undefined)?.verificationPhoto?.[0];
  const photo = file ? await uploadBuffer(file, "verifications") : null;
  const stale = photo ? existing.physicalVerification.photo : null;

  const asset = normalizeAsset({
    ...existing,
    physicalVerification: {
      verified: body.verified !== "false" && body.verified !== false,
      verifiedOn: toDate(body.verifiedOn) ?? new Date(),
      verifiedBy: String(body.verifiedBy ?? "").trim(),
      remarks: String(body.remarks ?? "").trim(),
      photo: photo ?? existing.physicalVerification.photo,
    },
    updatedAt: new Date(),
  });

  await repo.replace(asset);
  if (stale) await destroyFile(stale.publicId, stale.resourceType);

  res.json({ success: true, message: "Verification recorded", data: toApi(asset) });
}

/* ------------------------------------------------------------------ */
/* GET /api/assets/export                                              */
/* ------------------------------------------------------------------ */
export async function exportAssets(req: Request, res: Response): Promise<void> {
  const query = req.query as Record<string, string | undefined>;
  const matched = applySort(await loadFor(query), query);

  const workbook = await buildAssetWorkbook(matched.map((a) => withComputed(toApi(a))));

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
  res.setHeader("Content-Disposition", `attachment; filename="assets-${stamp}.xlsx"`);
  res.setHeader("Content-Length", String(workbook.length));
  res.send(workbook);
}

/* ------------------------------------------------------------------ */
/* GET /api/assets/:id/invoice                                         */
/* ------------------------------------------------------------------ */
export async function getAssetInvoice(req: Request, res: Response): Promise<void> {
  const asset = await loadOr404(req);

  const pdf = await buildAssetInvoice(withComputed(toApi(asset)));
  const safeCode = (asset.assetCode || "asset").replace(/[^A-Za-z0-9._-]/g, "-");

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${safeCode}-invoice.pdf"`);
  res.setHeader("Content-Length", String(pdf.length));
  res.send(pdf);
}

/* ------------------------------------------------------------------ */
/* GET /api/assets/meta/options                                        */
/* ------------------------------------------------------------------ */
export async function getFilterOptions(_req: Request, res: Response): Promise<void> {
  const assets = await repo.getAll();

  // DynamoDB has no DISTINCT, so the unique sets are built here.
  const distinct = (pick: (a: AssetRaw) => string) =>
    Array.from(new Set(assets.map(pick).map((v) => v.trim()).filter(Boolean))).sort((a, b) =>
      a.localeCompare(b)
    );

  res.json({
    success: true,
    data: {
      statuses: [...ASSET_STATUSES],
      entities: [...ENTITIES],
      entitiesInUse: distinct((a) => a.entity),
      departments: distinct((a) => a.department),
      locations: distinct((a) => a.location),
      categories: distinct((a) => a.category),
      products: distinct((a) => a.product),
      employees: distinct((a) => a.assignedEmployee.name),
    },
  });
}

/* ------------------------------------------------------------------ */
/* GET /api/assets/meta/stats                                          */
/* ------------------------------------------------------------------ */
export async function getStats(_req: Request, res: Response): Promise<void> {
  const assets = await repo.getAll();

  const now = new Date();
  const soon = new Date(now.getTime() + 30 * 86400000);

  let totalPurchaseValue = 0;
  let totalBookValue = 0;
  let unverified = 0;
  let warrantyExpiring = 0;
  let warrantyExpired = 0;

  const statusCounts: Record<string, number> = {
    Active: 0,
    Repair: 0,
    Sold: 0,
    Scrapped: 0,
  };
  const byEntityMap = new Map<string, { count: number; value: number }>();
  const byDepartmentMap = new Map<string, { count: number; value: number }>();
  const byCategoryMap = new Map<string, number>();
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

  for (const a of assets) {
    totalPurchaseValue += a.purchaseCost;
    totalBookValue += computeDepreciation(
      a.purchaseCost,
      a.purchaseDate,
      a.depreciation
    ).currentValue;

    if (!a.physicalVerification.verified) unverified += 1;
    statusCounts[a.status] = (statusCounts[a.status] ?? 0) + 1;

    bump(byEntityMap, a.entity, a.purchaseCost);
    bump(byDepartmentMap, a.department, a.purchaseCost);
    if (a.category) byCategoryMap.set(a.category, (byCategoryMap.get(a.category) ?? 0) + 1);

    const exp = a.warranty.expiryDate;
    if (exp) {
      if (exp < now) warrantyExpired += 1;
      else if (exp <= soon) warrantyExpiring += 1;
    }

    if (a.purchaseDate) {
      const key = `${a.purchaseDate.getFullYear()}-${String(
        a.purchaseDate.getMonth() + 1
      ).padStart(2, "0")}`;
      bump(monthlyMap, key, a.purchaseCost);
    }
  }

  const topBy = (map: Map<string, { count: number; value: number }>, limit: number) =>
    Array.from(map, ([name, v]) => ({ name, count: v.count, value: v.value }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);

  res.json({
    success: true,
    data: {
      totalAssets: assets.length,
      totalPurchaseValue: Math.round(totalPurchaseValue * 100) / 100,
      totalBookValue: Math.round(totalBookValue * 100) / 100,
      totalDepreciation: Math.round((totalPurchaseValue - totalBookValue) * 100) / 100,
      unverified,
      warrantyExpiring,
      warrantyExpired,
      statusCounts,
      byStatus: Object.entries(statusCounts).map(([name, count]) => ({
        name,
        count,
        value: 0,
      })),
      byEntity: topBy(byEntityMap, 10),
      byDepartment: topBy(byDepartmentMap, 8),
      byCategory: Array.from(byCategoryMap, ([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8),
      monthly: Array.from(monthlyMap, ([month, v]) => ({
        month,
        count: v.count,
        value: v.value,
      }))
        .sort((a, b) => a.month.localeCompare(b.month))
        .slice(-24),
    },
  });
}
