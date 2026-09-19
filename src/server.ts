import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { env } from "./config/env";
import * as repo from "./repositories/assetRepository";
import * as poRepo from "./repositories/purchaseOrderRepository";
import * as vendorRepo from "./repositories/vendorRepository";
import assetRoutes from "./routes/assetRoutes";
import purchaseOrderRoutes from "./routes/purchaseOrderRoutes";
import vendorRoutes from "./routes/vendorRoutes";
import authRoutes from "./routes/authRoutes";
import { requireAuth } from "./middleware/auth";
import { errorHandler, notFound } from "./middleware/errorHandler";

const app = express();

// Render (and most hosts) terminate TLS at a proxy, so the app sees plain http.
// Without this, req.secure and req.ip report the proxy's view rather than the
// client's.
app.set("trust proxy", 1);

app.use(
  cors({
    origin: env.clientOrigins,
    credentials: true,
  })
);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.get("/api/health", async (_req, res) => {
  // The two tables are probed separately: purchase orders can be missing while
  // the asset register is perfectly healthy, and the difference is the first
  // thing worth knowing.
  const probe = async (ping: () => Promise<boolean>): Promise<string> => {
    try {
      await ping();
      return "connected";
    } catch (err) {
      return `unavailable: ${(err as Error).name}`;
    }
  };

  const [database, poDatabase, vendorDatabase] = await Promise.all([
    probe(repo.ping),
    probe(poRepo.ping),
    probe(vendorRepo.ping),
  ]);

  res.json({
    success: true,
    service: "accounts-dashboard-api",
    env: env.nodeEnv,
    store: "dynamodb",
    table: env.aws.table,
    poTable: env.aws.poTable,
    vendorTable: env.aws.vendorTable,
    region: env.aws.region,
    database,
    poDatabase,
    vendorDatabase,
  });
});

app.use("/api/auth", authRoutes);

// Everything below the login wall. Without this the login screen would only be
// a curtain — the API would still answer anyone who called it directly.
app.use("/api/assets", requireAuth, assetRoutes);
app.use("/api/purchase-orders", requireAuth, purchaseOrderRoutes);
app.use("/api/vendors", requireAuth, vendorRoutes);

app.use(notFound);
app.use(errorHandler);

/**
 * DynamoDB needs no connection to hold open, so the server just listens. The
 * first read verifies credentials; a bad key or missing table surfaces per
 * request as a clean 503 rather than stopping the process from starting.
 */
async function start(): Promise<void> {
  app.listen(env.port, () => {
    console.log(`[api] listening on http://localhost:${env.port}`);
    console.log(`[ddb] table "${env.aws.table}" in ${env.aws.region}`);
  });

  try {
    await repo.ping();
    console.log(`[ddb] table "${env.aws.table}" reachable`);
  } catch (err) {
    const e = err as { name?: string; message?: string };
    console.error(`[ddb] table unreachable: ${e.name} - ${e.message}`);
    if (e.name === "ResourceNotFoundException") {
      console.error(`[ddb] hint: no table named "${env.aws.table}" in ${env.aws.region}`);
    }
    if (e.name === "UnrecognizedClientException" || e.name === "InvalidSignatureException") {
      console.error("[ddb] hint: check AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY");
    }
    if (e.name === "AccessDeniedException") {
      console.error("[ddb] hint: the IAM user needs dynamodb Get/Put/Delete/Scan on this table");
    }
  }

  try {
    await poRepo.ping();
    console.log(`[ddb] table "${env.aws.poTable}" reachable`);
  } catch (err) {
    const e = err as { name?: string; message?: string };
    console.error(`[ddb] purchase order table unreachable: ${e.name} - ${e.message}`);
    if (e.name === "ResourceNotFoundException") {
      console.error(
        `[ddb] hint: create a table named "${env.aws.poTable}" with partition key "entity" (String) and sort key "poNumber" (String), or set DYNAMODB_PO_TABLE`
      );
    }
  }

  try {
    await vendorRepo.ping();
    console.log(`[ddb] table "${env.aws.vendorTable}" reachable`);
  } catch (err) {
    const e = err as { name?: string; message?: string };
    console.error(`[ddb] vendor table unreachable: ${e.name} - ${e.message}`);
    if (e.name === "ResourceNotFoundException") {
      console.error(
        `[ddb] hint: create a table named "${env.aws.vendorTable}" with partition key "id" (String), or set DYNAMODB_VENDOR_TABLE`
      );
    }
  }
}

void start();
