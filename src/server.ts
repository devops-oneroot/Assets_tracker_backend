import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { env } from "./config/env";
import * as repo from "./repositories/assetRepository";
import assetRoutes from "./routes/assetRoutes";
import authRoutes from "./routes/authRoutes";
import { requireAuth } from "./middleware/auth";
import { errorHandler, notFound } from "./middleware/errorHandler";

const app = express();

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
  let database = "unknown";
  try {
    await repo.ping();
    database = "connected";
  } catch (err) {
    database = `unavailable: ${(err as Error).name}`;
  }
  res.json({
    success: true,
    service: "accounts-dashboard-api",
    env: env.nodeEnv,
    store: "dynamodb",
    table: env.aws.table,
    region: env.aws.region,
    database,
  });
});

app.use("/api/auth", authRoutes);

// Everything below the login wall. Without this the login screen would only be
// a curtain — the API would still answer anyone who called it directly.
app.use("/api/assets", requireAuth, assetRoutes);

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
    console.log("[ddb] table reachable");
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
}

void start();
