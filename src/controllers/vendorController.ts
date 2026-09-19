import type { Request, Response } from "express";
import { newVendorId, normalizeVendor, toApi, type VendorRaw } from "../models/Vendor";
import { nextVendorCode } from "../utils/vendorCode";
import * as repo from "../repositories/vendorRepository";
import { ApiError } from "../middleware/errorHandler";

const trim = (value: unknown): string => String(value ?? "").trim();

function asTags(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return Array.from(new Set(raw.map((t) => trim(t)).filter(Boolean)));
}

function buildPayload(body: Record<string, unknown>) {
  return {
    name: trim(body.name),
    vendorCode: trim(body.vendorCode),
    category: trim(body.category),
    gstNumber: trim(body.gstNumber).toUpperCase(),
    address: trim(body.address),
    contactPerson: trim(body.contactPerson),
    phone: trim(body.phone),
    email: trim(body.email).toLowerCase(),
    suppliesTags: asTags(body.suppliesTags),
    notes: trim(body.notes),
  };
}

/**
 * Category is `strict`-only, so only *adding* a new vendor requires picking
 * or typing one - a vendor saved before this field existed (or created
 * automatically from a PO's Supplier section) can still be edited without
 * being forced to categorise itself first.
 */
function assertRequired(
  payload: { name: string; category: string },
  opts: { strict?: boolean } = {}
): void {
  if (!payload.name) throw new ApiError(400, "Vendor name is required");
  if (opts.strict && !payload.category) {
    throw new ApiError(400, "Pick or type a category for this vendor");
  }
}

/* ------------------------------------------------------------------ */
/* GET /api/vendors/meta/categories                                    */
/* ------------------------------------------------------------------ */

/** Every category already in use, for the datalist that lets you type a new one too. */
export async function listVendorCategories(_req: Request, res: Response): Promise<void> {
  const vendors = await repo.getAll();
  const categories = Array.from(new Set(vendors.map((v) => v.category.trim()).filter(Boolean)));
  categories.sort((a, b) => a.localeCompare(b));
  res.json({ success: true, data: categories });
}

/* ------------------------------------------------------------------ */
/* GET /api/vendors/meta/next-code                                     */
/* ------------------------------------------------------------------ */

/**
 * Suggests the next code within a category, e.g. "STE0003" - a suggestion
 * only, nothing is reserved until the vendor is actually saved. Scoped to
 * vendors whose category text actually matches (see utils/vendorCode.ts for
 * why that matters more than it sounds), and shared across both companies -
 * there is no per-entity series to keep separate here.
 */
export async function getNextVendorCode(req: Request, res: Response): Promise<void> {
  const category = trim(req.query.category);
  const vendors = await repo.getAll();
  const vendorCode = nextVendorCode(category, vendors);
  res.json({ success: true, data: { vendorCode } });
}

/* ------------------------------------------------------------------ */
/* GET /api/vendors                                                    */
/* ------------------------------------------------------------------ */
export async function listVendors(req: Request, res: Response): Promise<void> {
  const query = req.query as Record<string, string | undefined>;
  const vendors = await repo.search(query.search);

  vendors.sort((a, b) => a.name.localeCompare(b.name));

  res.json({ success: true, data: vendors.map(toApi) });
}

/* ------------------------------------------------------------------ */
/* GET /api/vendors/:id                                                */
/* ------------------------------------------------------------------ */
export async function getVendor(req: Request, res: Response): Promise<void> {
  const vendor = await repo.getById(String(req.params.id ?? ""));
  if (!vendor) throw new ApiError(404, "Vendor not found");
  res.json({ success: true, data: toApi(vendor) });
}

/* ------------------------------------------------------------------ */
/* POST /api/vendors                                                   */
/* ------------------------------------------------------------------ */
export async function createVendor(req: Request, res: Response): Promise<void> {
  const payload = buildPayload((req.body ?? {}) as Record<string, unknown>);
  assertRequired(payload, { strict: true });

  const now = new Date();
  const vendor = normalizeVendor({
    ...payload,
    id: newVendorId(),
    createdAt: now,
    updatedAt: now,
  });

  await repo.create(vendor);
  res.status(201).json({ success: true, message: "Vendor added", data: toApi(vendor) });
}

/* ------------------------------------------------------------------ */
/* PUT /api/vendors/:id                                                */
/* ------------------------------------------------------------------ */
export async function updateVendor(req: Request, res: Response): Promise<void> {
  const existing = await repo.getById(String(req.params.id ?? ""));
  if (!existing) throw new ApiError(404, "Vendor not found");

  const payload = buildPayload((req.body ?? {}) as Record<string, unknown>);
  assertRequired(payload);

  const vendor: VendorRaw = normalizeVendor({
    ...existing,
    ...payload,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date(),
  });

  await repo.replace(vendor);
  res.json({ success: true, message: "Vendor updated", data: toApi(vendor) });
}

/* ------------------------------------------------------------------ */
/* DELETE /api/vendors/:id                                             */
/* ------------------------------------------------------------------ */
export async function deleteVendor(req: Request, res: Response): Promise<void> {
  const existing = await repo.getById(String(req.params.id ?? ""));
  if (!existing) throw new ApiError(404, "Vendor not found");

  await repo.remove(existing.id);
  res.json({ success: true, message: `Vendor "${existing.name}" deleted` });
}
