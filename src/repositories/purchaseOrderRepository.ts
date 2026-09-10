import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb, PO_TABLE } from "../config/dynamo";
import {
  normalizePurchaseOrder,
  toItem,
  type PurchaseOrderRaw,
} from "../models/PurchaseOrder";

/**
 * All DynamoDB access for purchase orders.
 *
 * The table is keyed on (entity, poNumber) — partition by buying company, sort
 * by PO number — mirroring the asset register, so a PO number only has to be
 * unique within its own company.
 *
 * Filtering to a single company is a real Query; everything else is a Scan plus
 * in-memory sorting, which is the right trade at this volume.
 */

/** Scan hard-stops here so a runaway table cannot exhaust memory. */
const MAX_ITEMS = 10000;

export interface PoKey {
  entity: string;
  poNumber: string;
}

export interface PoFilterInput {
  search?: string | undefined;
  status?: string | undefined;
  entity?: string | undefined;
  supplier?: string | undefined;
  department?: string | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
}

interface BuiltFilter {
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

/**
 * Builds the FilterExpression from the register's query string, so the filtering
 * happens in DynamoDB rather than in Node.
 */
function buildFilter(input: PoFilterInput, skipEntity: boolean): BuiltFilter {
  const parts: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};

  // Every attribute goes through a name placeholder — `status` and `name` are
  // DynamoDB reserved words.
  const name = (attr: string): string => {
    const key = `#${attr.replace(/[^A-Za-z0-9]/g, "")}`;
    names[key] = attr;
    return key;
  };

  const inList = (attr: string, raw: string | undefined, prefix: string) => {
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
  if (!skipEntity) inList("entity", input.entity, "en");
  inList("department", input.department, "dp");

  // Supplier is a substring match, not a list — names are typed by hand and
  // rarely agree on spacing or suffixes between one order and the next.
  if (input.supplier?.trim()) {
    values[":supplier"] = input.supplier.trim().toLowerCase();
    parts.push(`contains(${name("searchText")}, :supplier)`);
  }

  const from = isoStart(input.dateFrom);
  const to = isoEnd(input.dateTo);
  if (from && to) {
    values[":from"] = from;
    values[":to"] = to;
    parts.push(`${name("poDate")} BETWEEN :from AND :to`);
  } else if (from) {
    values[":from"] = from;
    parts.push(`${name("poDate")} >= :from`);
  } else if (to) {
    values[":to"] = to;
    parts.push(`${name("poDate")} <= :to`);
  }

  return {
    ...(parts.length ? { expression: parts.join(" AND ") } : {}),
    names,
    values,
  };
}

/** Reads the orders matching `filters`, with the filtering done by DynamoDB. */
export async function queryOrders(filters: PoFilterInput): Promise<PurchaseOrderRaw[]> {
  const entities = multi(filters.entity);

  // One company: pin it with a key condition and drop it from the filter.
  const single = entities.length === 1 ? entities[0]! : null;
  const built = buildFilter(filters, !!single);

  const names = { ...built.names };
  const values = { ...built.values };
  if (single) {
    names["#pkEntity"] = "entity";
    values[":pkEntity"] = single;
  }

  const items: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const base = {
      TableName: PO_TABLE,
      ExclusiveStartKey: lastKey,
      ...(built.expression ? { FilterExpression: built.expression } : {}),
      ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
      ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
    };

    const res = single
      ? await ddb.send(
          new QueryCommand({ ...base, KeyConditionExpression: "#pkEntity = :pkEntity" })
        )
      : await ddb.send(new ScanCommand(base));

    items.push(...((res.Items ?? []) as Record<string, unknown>[]));
    lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;

    if (items.length >= MAX_ITEMS) {
      console.warn(`[ddb] purchase order read stopped at ${MAX_ITEMS} items`);
      break;
    }
  } while (lastKey);

  return items.map(normalizePurchaseOrder);
}

export async function getAll(): Promise<PurchaseOrderRaw[]> {
  const items: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const res = await ddb.send(
      new ScanCommand({ TableName: PO_TABLE, ExclusiveStartKey: lastKey })
    );
    items.push(...((res.Items ?? []) as Record<string, unknown>[]));
    lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;

    if (items.length >= MAX_ITEMS) {
      console.warn(`[ddb] purchase order scan stopped at ${MAX_ITEMS} items`);
      break;
    }
  } while (lastKey);

  return items.map(normalizePurchaseOrder);
}

export async function getByKey(key: PoKey): Promise<PurchaseOrderRaw | null> {
  if (!key.entity || !key.poNumber) return null;
  const res = await ddb.send(
    new GetCommand({
      TableName: PO_TABLE,
      Key: { entity: key.entity, poNumber: key.poNumber },
    })
  );
  return res.Item ? normalizePurchaseOrder(res.Item as Record<string, unknown>) : null;
}

export async function exists(key: PoKey): Promise<boolean> {
  if (!key.entity || !key.poNumber) return false;
  const res = await ddb.send(
    new GetCommand({
      TableName: PO_TABLE,
      Key: { entity: key.entity, poNumber: key.poNumber },
      ProjectionExpression: "poNumber",
    })
  );
  return !!res.Item;
}

/** Thrown when a conditional write loses — the number was taken for that company. */
export class DuplicatePoNumberError extends Error {
  constructor(entity: string, poNumber: string) {
    super(`PO number ${poNumber} is already in use for ${entity}`);
    this.name = "DuplicatePoNumberError";
  }
}

/**
 * Writes a new order, letting DynamoDB enforce uniqueness within the company.
 * The condition makes this safe against two people submitting the same number at
 * once, which a read-then-write check cannot do.
 */
export async function create(po: PurchaseOrderRaw): Promise<PurchaseOrderRaw> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: PO_TABLE,
        Item: toItem(po),
        // On a composite key this means "no item at this entity + poNumber".
        ConditionExpression: "attribute_not_exists(#e)",
        ExpressionAttributeNames: { "#e": "entity" },
      })
    );
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
      throw new DuplicatePoNumberError(po.entity, po.poNumber);
    }
    throw err;
  }
  return po;
}

/** Replaces an existing order in place; fails if it has since been deleted. */
export async function replace(po: PurchaseOrderRaw): Promise<PurchaseOrderRaw> {
  await ddb.send(
    new PutCommand({
      TableName: PO_TABLE,
      Item: toItem(po),
      ConditionExpression: "attribute_exists(#e)",
      ExpressionAttributeNames: { "#e": "entity" },
    })
  );
  return po;
}

/**
 * Moves an order to a new company and/or PO number.
 *
 * Both are key attributes and cannot be updated, so the record is written under
 * the new key and the old one removed. The write is conditional, so a clash
 * leaves the original untouched.
 */
export async function move(
  previous: PoKey,
  po: PurchaseOrderRaw
): Promise<PurchaseOrderRaw> {
  await create(po);
  await remove(previous);
  return po;
}

export async function remove(key: PoKey): Promise<void> {
  await ddb.send(
    new DeleteCommand({
      TableName: PO_TABLE,
      Key: { entity: key.entity, poNumber: key.poNumber },
    })
  );
}

/** Cheap liveness probe used by /api/health. */
export async function ping(): Promise<boolean> {
  await ddb.send(
    new ScanCommand({ TableName: PO_TABLE, Limit: 1, ProjectionExpression: "poNumber" })
  );
  return true;
}
