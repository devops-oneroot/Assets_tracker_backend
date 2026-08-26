import type { Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "crypto";
import jwt from "jsonwebtoken";
import { env } from "../config/env";

const COOKIE = "at_session";

/**
 * Compares without leaking length or content through timing.
 * Buffers of different lengths cannot go through timingSafeEqual at all, so the
 * length check is done first and the comparison still runs to keep timing flat.
 */
function passwordMatches(candidate: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(env.auth.password);
  if (a.length !== b.length) {
    // Still do a comparison so a wrong-length guess is not measurably faster.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function signSession(res: Response): void {
  const token = jwt.sign({ role: "admin" }, env.auth.jwtSecret, {
    expiresIn: `${env.auth.sessionHours}h`,
  });

  res.cookie(COOKIE, token, {
    httpOnly: true, // JavaScript cannot read it, so XSS cannot steal the session
    sameSite: "lax",
    secure: env.nodeEnv === "production",
    maxAge: env.auth.sessionHours * 60 * 60 * 1000,
    path: "/",
  });
}

export function clearSession(res: Response): void {
  res.clearCookie(COOKIE, { path: "/" });
}

export function isAuthenticated(req: Request): boolean {
  const token = (req.cookies as Record<string, string> | undefined)?.[COOKIE];
  if (!token) return false;
  try {
    jwt.verify(token, env.auth.jwtSecret);
    return true;
  } catch {
    return false;
  }
}

/** Rejects anything without a valid session cookie. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (isAuthenticated(req)) return next();
  res.status(401).json({ success: false, message: "Not signed in" });
}

export { passwordMatches };
