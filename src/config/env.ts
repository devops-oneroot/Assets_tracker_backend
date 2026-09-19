import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

function required(key: string): string {
  const value = process.env[key];
  if (!value || !value.trim()) {
    throw new Error(
      `Missing required environment variable "${key}". Add it to backend/.env`
    );
  }
  return value.trim();
}

const clientOrigins = (process.env.CLIENT_ORIGIN ?? "http://localhost:3000")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

/**
 * True when the browser will be on a different site from this API — the frontend
 * is served over https from another domain (Vercel) while the API is elsewhere
 * (Render). A SameSite=Lax cookie is silently dropped on such requests, so the
 * session cookie has to become SameSite=None; Secure.
 *
 * Derived from CLIENT_ORIGIN rather than NODE_ENV, because NODE_ENV is not
 * reliably set on the host and getting this wrong breaks login with no error.
 */
const crossSite = clientOrigins.some((o) => o.startsWith("https://"));

export const env = {
  port: Number(process.env.PORT ?? 5000),
  nodeEnv: process.env.NODE_ENV ?? "development",
  aws: {
    region: required("AWS_REGION"),
    accessKeyId: required("AWS_ACCESS_KEY_ID"),
    secretAccessKey: required("AWS_SECRET_ACCESS_KEY"),
    table: required("DYNAMODB_TABLE"),
    // Purchase orders live in their own table so they never turn up in an asset
    // scan, export or stat. Defaults to a sibling of the asset table.
    poTable:
      process.env.DYNAMODB_PO_TABLE?.trim() ||
      `${required("DYNAMODB_TABLE")}-purchase-orders`,
    // The vendor master, likewise its own table. Shared across both companies -
    // a vendor is not owned by ENP or GCC, so this has no per-entity default the
    // way the other two tables do.
    vendorTable:
      process.env.DYNAMODB_VENDOR_TABLE?.trim() ||
      `${required("DYNAMODB_TABLE")}-vendors`,
  },
  clientOrigins,
  crossSite,
  auth: {
    password: required("APP_PASSWORD"),
    jwtSecret: required("JWT_SECRET"),
    sessionHours: Number(process.env.SESSION_HOURS ?? 12),
  },
  cloudinary: {
    cloudName: required("CLOUD_NAME"),
    apiKey: required("CLOUD_API_KEY"),
    apiSecret: required("CLOUD_API_SECRET"),
    folder: process.env.CLOUD_FOLDER ?? "accounts-dashboard/assets",
  },
};
