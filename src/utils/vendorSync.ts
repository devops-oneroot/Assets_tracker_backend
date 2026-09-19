import { newVendorId, normalizeVendor } from "../models/Vendor";
import * as vendorRepo from "../repositories/vendorRepository";
import type { SupplierDoc } from "../models/PurchaseOrder";

/**
 * Folds a purchase order's Supplier block into the vendor master.
 *
 * This is one-way and best-effort: raising or editing a PO can teach the
 * vendor master a new "what they supply" tag - or, for a supplier typed in
 * for the first time, create the vendor record outright - but it never
 * overwrites a vendor's own saved contact details. Those stay owned by the
 * Vendor tab, so a typo on one PO can't quietly corrupt the master record
 * every other order pulls from.
 *
 * Failure here must never fail the PO save itself: the order is the thing the
 * user actually asked to do, and this is a convenience on top of it.
 */
export async function syncVendorFromSupplier(
  supplier: SupplierDoc,
  newTags: string[],
  /**
   * The PO's own vendorCode field. Only used when *creating* a brand-new
   * vendor - an existing vendor keeps whatever code it already has, so this
   * can never overwrite one already assigned from the Vendor tab.
   */
  vendorCode: string,
  /** Same as `vendorCode` above: only applied to a brand-new vendor. */
  category: string
): Promise<void> {
  if (!supplier.name.trim()) return;

  try {
    const existing = await vendorRepo.getByName(supplier.name);

    if (existing) {
      if (!newTags.length) return;
      const merged = Array.from(
        new Set([...existing.suppliesTags, ...newTags].map((t) => t.trim()).filter(Boolean))
      );
      if (merged.length === existing.suppliesTags.length) return;

      const vendor = normalizeVendor({ ...existing, suppliesTags: merged, updatedAt: new Date() });
      await vendorRepo.replace(vendor);
      return;
    }

    // A supplier typed in for the first time becomes a new vendor, carrying
    // over whatever contact details (and code) were entered on the order.
    const now = new Date();
    const vendor = normalizeVendor({
      id: newVendorId(),
      name: supplier.name,
      vendorCode,
      category,
      gstNumber: supplier.gstNumber,
      address: supplier.address,
      contactPerson: supplier.contactPerson,
      phone: supplier.phone,
      email: supplier.email,
      suppliesTags: newTags,
      notes: "",
      createdAt: now,
      updatedAt: now,
    });
    await vendorRepo.create(vendor);
  } catch (err) {
    console.error("[vendor-sync] could not sync vendor from PO supplier:", err);
  }
}
