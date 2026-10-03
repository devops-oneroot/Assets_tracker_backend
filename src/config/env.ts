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
  // Optional: powers "Import from PDF" on the PO form. Left unset, that
  // feature fails with a clear setup message rather than blocking startup -
  // the rest of the app has nothing to do with it.
  gemini: {
    apiKey: process.env.GEMINI_API_KEY?.trim() ?? "",
    // An alias, so Google's renames don't strand us the way gemini-2.0-flash
    // and gemini-2.5-flash both did. "lite" because the free tier rations the
    // premium models hard (gemini-3.6-flash: 20 documents a day) while the
    // small ones read an invoice just as accurately, several times faster.
    // utils/geminiDoc.ts falls through to others if this one cannot serve.
    model: process.env.GEMINI_MODEL?.trim() || "gemini-flash-lite-latest",
  },
};
