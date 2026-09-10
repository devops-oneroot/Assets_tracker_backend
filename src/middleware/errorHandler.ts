import type { Request, Response, NextFunction, RequestHandler } from "express";
import { MulterError } from "multer";

export class ApiError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

export const asyncHandler =
  (fn: RequestHandler): RequestHandler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

export function notFound(req: Request, res: Response): void {
  res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.originalUrl}` });
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof MulterError) {
    const message =
      err.code === "LIMIT_FILE_SIZE" ? "File too large (max 10 MB)" : err.message;
    res.status(400).json({ success: false, message });
    return;
  }

  if (err instanceof ApiError) {
    res.status(err.statusCode).json({ success: false, message: err.message });
    return;
  }

  const e = err as { name?: string; code?: number; message?: string; errors?: Record<string, { message: string }> };

  // A conditional write lost the race — the FA code or PO number was taken
  // between the pre-check and the put.
  if (
    e?.name === "ConditionalCheckFailedException" ||
    e?.name === "DuplicateCodeError" ||
    e?.name === "DuplicatePoNumberError"
  ) {
    res.status(409).json({
      success: false,
      message: e.message || "That code is already in use",
    });
    return;
  }

  const DDB_UNAVAILABLE = new Set([
    "ResourceNotFoundException",
    "UnrecognizedClientException",
    "InvalidSignatureException",
    "AccessDeniedException",
    "ProvisionedThroughputExceededException",
    "RequestLimitExceeded",
    "ThrottlingException",
    "TimeoutError",
    "NetworkingError",
  ]);

  if (e?.name && DDB_UNAVAILABLE.has(e.name)) {
    console.error("[ddb] unavailable:", e.name, "-", e.message);
    const message =
      e.name === "ResourceNotFoundException"
        ? "A DynamoDB table was not found — check DYNAMODB_TABLE / DYNAMODB_PO_TABLE and AWS_REGION."
        : e.name === "AccessDeniedException"
          ? "AWS credentials lack permission for this table."
          : e.name === "UnrecognizedClientException" || e.name === "InvalidSignatureException"
            ? "AWS credentials are invalid."
            : "Database temporarily unreachable — please retry.";
    res.status(503).json({ success: false, message });
    return;
  }

  console.error("[error]", err);
  res.status(500).json({ success: false, message: e?.message || "Internal server error" });
}
