import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { env } from "./env";

const client = new DynamoDBClient({
  region: env.aws.region,
  credentials: {
    accessKeyId: env.aws.accessKeyId,
    secretAccessKey: env.aws.secretAccessKey,
  },
});

/**
 * The document client marshals plain JS objects for us.
 * `removeUndefinedValues` matters: DynamoDB rejects `undefined`, which is easy to
 * produce from optional form fields.
 */
export const ddb = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    removeUndefinedValues: true,
    convertClassInstanceToMap: true,
  },
});

export const TABLE = env.aws.table;
export const PO_TABLE = env.aws.poTable;
export const VENDOR_TABLE = env.aws.vendorTable;
