import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb, VENDOR_TABLE } from "../config/dynamo";
import { normalizeVendor, toItem, type VendorRaw } from "../models/Vendor";

/**
 * All DynamoDB access for the vendor master.
 *
 * Keyed on a single generated `id` - there is no natural business key the way
 * an FA code or PO number is one, and a vendor is not scoped to a company, so
 * there is no partition key to Query on either. At vendor-master scale (tens
 * to low hundreds of rows) a full Scan plus an in-memory search is the right
 * trade for the simplicity it buys.
 */

const MAX_ITEMS = 10000;

export async function getAll(): Promise<VendorRaw[]> {
  const items: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const res = await ddb.send(
      new ScanCommand({ TableName: VENDOR_TABLE, ExclusiveStartKey: lastKey })
    );
    items.push(...((res.Items ?? []) as Record<string, unknown>[]));
    lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;

    if (items.length >= MAX_ITEMS) {
      console.warn(`[ddb] vendor scan stopped at ${MAX_ITEMS} items`);
      break;
    }
  } while (lastKey);

  return items.map(normalizeVendor);
}

/**
 * Every vendor whose search text contains `search`, case-insensitively.
 *
 * Filtered in Node rather than with a DynamoDB FilterExpression: `contains()`
 * in DynamoDB is case-sensitive, and the list is small enough that reading it
 * all and filtering in memory is simpler than lower-casing on write and hoping
 * every future field remembers to.
 */
export async function search(term?: string): Promise<VendorRaw[]> {
  const all = await getAll();
  const needle = (term ?? "").trim().toLowerCase();
  if (!needle) return all;
  return all.filter((v) => v.name.toLowerCase().includes(needle) || matchesSearchText(v, needle));
}

function matchesSearchText(v: VendorRaw, needle: string): boolean {
  return [v.vendorCode, v.category, v.gstNumber, v.contactPerson, v.phone, v.email, ...v.suppliesTags]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

export async function getById(id: string): Promise<VendorRaw | null> {
  if (!id) return null;
  const res = await ddb.send(new GetCommand({ TableName: VENDOR_TABLE, Key: { id } }));
  return res.Item ? normalizeVendor(res.Item as Record<string, unknown>) : null;
}

/**
 * The vendor whose name matches exactly, case-insensitively.
 *
 * Used to fold a purchase order's Supplier block into the vendor master on
 * save: an exact name match is treated as the same vendor, anything else is
 * a new one. There is no fuzzy matching - "S And G Steel" and "S and G Steel
 * Infra" are different vendors as far as this is concerned.
 */
export async function getByName(name: string): Promise<VendorRaw | null> {
  const needle = name.trim().toLowerCase();
  if (!needle) return null;
  const all = await getAll();
  return all.find((v) => v.name.trim().toLowerCase() === needle) ?? null;
}

export async function create(vendor: VendorRaw): Promise<VendorRaw> {
  await ddb.send(
    new PutCommand({
      TableName: VENDOR_TABLE,
      Item: toItem(vendor),
      // The id is freshly generated for every create, so this only ever trips
      // over a genuine (astronomically unlikely) UUID collision.
      ConditionExpression: "attribute_not_exists(id)",
    })
  );
  return vendor;
}

/** Replaces an existing vendor in place; fails if it has since been deleted. */
export async function replace(vendor: VendorRaw): Promise<VendorRaw> {
  await ddb.send(
    new PutCommand({
      TableName: VENDOR_TABLE,
      Item: toItem(vendor),
      ConditionExpression: "attribute_exists(id)",
    })
  );
  return vendor;
}

export async function remove(id: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: VENDOR_TABLE, Key: { id } }));
}

/** Cheap liveness probe used by /api/health. */
export async function ping(): Promise<boolean> {
  await ddb.send(
    new ScanCommand({ TableName: VENDOR_TABLE, Limit: 1, ProjectionExpression: "id" })
  );
  return true;
}
