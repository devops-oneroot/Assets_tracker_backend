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

export const env = {
  port: Number(process.env.PORT ?? 5000),
  nodeEnv: process.env.NODE_ENV ?? "development",
  aws: {
    region: required("AWS_REGION"),
    accessKeyId: required("AWS_ACCESS_KEY_ID"),
    secretAccessKey: required("AWS_SECRET_ACCESS_KEY"),
    table: required("DYNAMODB_TABLE"),
  },
  clientOrigins: (process.env.CLIENT_ORIGIN ?? "http://localhost:3000")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
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
