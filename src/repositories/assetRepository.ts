import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "../config/dynamo";
import { normalizeAsset, toItem, type AssetRaw } from "../models/Asset";
import { buildFilter, type FilterInput } from "./assetFilter";

/**
 * All DynamoDB access lives here.
 *
 * The table is keyed on (entity, assetCode) — partition by company, sort by FA
 * code — so an FA code only has to be unique within its own company: ENP 001 and
 * GCC 001 are two different assets.
 *
 * Filtering by a single entity is a real Query. Everything else (search, sorting
 * by arbitrary columns, stats) is a Scan plus in-memory work, which is the right
 * trade for a register of this size but the thing to revisit if it grows large.
 */

/** Scan hard-stops here so a runaway table cannot exhaust memory. */
const MAX_ITEMS = 10000;

export interface AssetKey {
  entity: string;
  assetCode: string;
}

/**
 * Reads the assets matching `filters`, with the filtering done by DynamoDB.
 *
 * A single-entity filter narrows to a Query on the partition key; anything else
 * is a Scan. Either way the FilterExpression is evaluated in the database, so
 * only matching items come back over the wire.
 */
export async function queryAssets(filters: FilterInput): Promise<AssetRaw[]> {
  const entities = (filters.entity ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  // One company: pin it with a key condition and drop it from the filter.
  const single = entities.length === 1 ? entities[0]! : null;
  const built = buildFilter(filters, { skipEntity: !!single });

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
      TableName: TABLE,
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
      console.warn(`[ddb] read stopped at ${MAX_ITEMS} items`);
      break;
    }
  } while (lastKey);

  return items.map(normalizeAsset);
}

export async function getAll(): Promise<AssetRaw[]> {
  const items: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const res = await ddb.send(
      new ScanCommand({ TableName: TABLE, ExclusiveStartKey: lastKey })
    );
    items.push(...((res.Items ?? []) as Record<string, unknown>[]));
    lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;

    if (items.length >= MAX_ITEMS) {
      console.warn(`[ddb] scan stopped at ${MAX_ITEMS} items`);
      break;
    }
  } while (lastKey);

  return items.map(normalizeAsset);
}

/** Every asset for one company — a Query on the partition key, not a Scan. */
export async function getByEntity(entity: string): Promise<AssetRaw[]> {
  const items: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "#e = :e",
        ExpressionAttributeNames: { "#e": "entity" },
        ExpressionAttributeValues: { ":e": entity },
        ExclusiveStartKey: lastKey,
      })
    );
    items.push(...((res.Items ?? []) as Record<string, unknown>[]));
    lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey && items.length < MAX_ITEMS);

  return items.map(normalizeAsset);
}

export async function getByKey(key: AssetKey): Promise<AssetRaw | null> {
  if (!key.entity || !key.assetCode) return null;
  const res = await ddb.send(
    new GetCommand({
      TableName: TABLE,
      Key: { entity: key.entity, assetCode: key.assetCode },
    })
  );
  return res.Item ? normalizeAsset(res.Item as Record<string, unknown>) : null;
}

export async function exists(key: AssetKey): Promise<boolean> {
  if (!key.entity || !key.assetCode) return false;
  const res = await ddb.send(
    new GetCommand({
      TableName: TABLE,
      Key: { entity: key.entity, assetCode: key.assetCode },
      ProjectionExpression: "assetCode",
    })
  );
  return !!res.Item;
}

/** Thrown when a conditional write loses — the code was taken for that company. */
export class DuplicateCodeError extends Error {
  constructor(entity: string, assetCode: string) {
    super(`FA code ${assetCode} is already in use for ${entity}`);
    this.name = "DuplicateCodeError";
  }
}

/**
 * Writes a new asset, letting DynamoDB enforce uniqueness within the company.
 * The condition makes this safe against two people submitting the same code at
 * once, which a read-then-write check cannot do.
 */
export async function create(asset: AssetRaw): Promise<AssetRaw> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: toItem(asset),
        // On a composite key this means "no item at this entity + assetCode".
        ConditionExpression: "attribute_not_exists(#e)",
        ExpressionAttributeNames: { "#e": "entity" },
      })
    );
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
      throw new DuplicateCodeError(asset.entity, asset.assetCode);
    }
    throw err;
  }
  return asset;
}

/** Replaces an existing asset in place; fails if it has since been deleted. */
export async function replace(asset: AssetRaw): Promise<AssetRaw> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: toItem(asset),
      ConditionExpression: "attribute_exists(#e)",
      ExpressionAttributeNames: { "#e": "entity" },
    })
  );
  return asset;
}

/**
 * Moves an asset to a new company and/or FA code.
 *
 * Both are key attributes and cannot be updated, so the record is written under
 * the new key and the old one removed. The write is conditional, so a clash
 * leaves the original untouched.
 */
export async function move(previous: AssetKey, asset: AssetRaw): Promise<AssetRaw> {
  await create(asset);
  await remove(previous);
  return asset;
}

export async function remove(key: AssetKey): Promise<void> {
  await ddb.send(
    new DeleteCommand({
      TableName: TABLE,
      Key: { entity: key.entity, assetCode: key.assetCode },
    })
  );
}

/** Cheap liveness probe used by /api/health. */
export async function ping(): Promise<boolean> {
  await ddb.send(
    new ScanCommand({ TableName: TABLE, Limit: 1, ProjectionExpression: "assetCode" })
  );
  return true;
}
