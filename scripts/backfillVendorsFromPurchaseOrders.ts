/**
 * One-time backfill: creates a vendor record for every unique supplier
 * already used on a purchase order, so the Vendor tab doesn't start empty.
 *
 * Going forward, raising or editing a PO already folds its Supplier block
 * into the vendor master on its own (see src/utils/vendorSync.ts) - this
 * script exists purely to catch up on orders that were saved before that
 * existed.
 *
 * Safe to re-run: a supplier whose name already matches a saved vendor is
 * left untouched, never overwritten. Defaults to a dry run - nothing is
 * written until you pass --apply.
 *
 * Usage (from backend/):
 *   npx tsx scripts/backfillVendorsFromPurchaseOrders.ts            # preview
 *   npx tsx scripts/backfillVendorsFromPurchaseOrders.ts --apply    # write
 */
import * as poRepo from "../src/repositories/purchaseOrderRepository";
import * as vendorRepo from "../src/repositories/vendorRepository";
import { newVendorId, normalizeVendor } from "../src/models/Vendor";
import type { PurchaseOrderRaw } from "../src/models/PurchaseOrder";

const APPLY = process.argv.includes("--apply");

interface Collected {
  name: string;
  gstNumber: string;
  address: string;
  contactPerson: string;
  phone: string;
  email: string;
  poCount: number;
}

/** One entry per distinct supplier name, newest PO's non-empty fields win. */
function collectSuppliers(orders: PurchaseOrderRaw[]): Map<string, Collected> {
  const byKey = new Map<string, Collected>();

  const sorted = [...orders].sort(
    (a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0)
  );

  for (const po of sorted) {
    const name = po.supplier.name.trim();
    if (!name) continue;
    const key = name.toLowerCase();

    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        name,
        gstNumber: po.supplier.gstNumber.trim(),
        address: po.supplier.address.trim(),
        contactPerson: po.supplier.contactPerson.trim(),
        phone: po.supplier.phone.trim(),
        email: po.supplier.email.trim(),
        poCount: 1,
      });
      continue;
    }

    existing.poCount += 1;
    // Already newest-first, so only fill in gaps the later (older) POs might
    // have that the newest one didn't.
    existing.gstNumber ||= po.supplier.gstNumber.trim();
    existing.address ||= po.supplier.address.trim();
    existing.contactPerson ||= po.supplier.contactPerson.trim();
    existing.phone ||= po.supplier.phone.trim();
    existing.email ||= po.supplier.email.trim();
  }

  return byKey;
}

async function main() {
  console.log(APPLY ? "Running LIVE - vendors will be created.\n" : "Dry run - nothing will be written. Pass --apply to actually create vendors.\n");

  const orders = await poRepo.getAll();
  console.log(`Scanned ${orders.length} purchase order(s).`);

  const suppliers = collectSuppliers(orders);
  console.log(`Found ${suppliers.size} distinct supplier name(s).\n`);

  let created = 0;
  let skipped = 0;

  for (const supplier of suppliers.values()) {
    const existingVendor = await vendorRepo.getByName(supplier.name);
    if (existingVendor) {
      skipped += 1;
      console.log(`- skip   "${supplier.name}" (already a vendor)`);
      continue;
    }

    console.log(
      `+ create "${supplier.name}" (from ${supplier.poCount} PO${supplier.poCount === 1 ? "" : "s"})`
    );

    if (APPLY) {
      const now = new Date();
      const vendor = normalizeVendor({
        id: newVendorId(),
        name: supplier.name,
        vendorCode: "",
        gstNumber: supplier.gstNumber,
        address: supplier.address,
        contactPerson: supplier.contactPerson,
        phone: supplier.phone,
        email: supplier.email,
        suppliesTags: [],
        notes: "",
        createdAt: now,
        updatedAt: now,
      });
      await vendorRepo.create(vendor);
    }
    created += 1;
  }

  console.log(
    `\n${APPLY ? "Created" : "Would create"} ${created} vendor(s). Skipped ${skipped} (already on file).`
  );
  if (!APPLY && created > 0) {
    console.log("\nRe-run with --apply to actually write these.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    const e = err as { name?: string; message?: string };
    if (e?.name === "ResourceNotFoundException") {
      console.error(
        "\n[backfill] the vendor table doesn't exist yet. Create it first " +
          "(partition key \"id\", String, no sort key) and set DYNAMODB_VENDOR_TABLE, " +
          "then re-run this script."
      );
    } else {
      console.error("[backfill] failed:", err);
    }
    process.exit(1);
  });
