import { Router } from "express";
import { asyncHandler } from "../middleware/errorHandler";
import {
  clearSession,
  isAuthenticated,
  passwordMatches,
  signSession,
} from "../middleware/auth";

const router = Router();

/** A deliberate small delay blunts brute-forcing a single shared password. */
const THROTTLE_MS = 400;

router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const password = String((req.body as { password?: unknown })?.password ?? "");

    await new Promise((resolve) => setTimeout(resolve, THROTTLE_MS));

    if (!password || !passwordMatches(password)) {
      res.status(401).json({ success: false, message: "Incorrect password" });
      return;
    }

    signSession(res);
    res.json({ success: true, message: "Signed in" });
  })
);

router.post("/logout", (_req, res) => {
  clearSession(res);
  res.json({ success: true, message: "Signed out" });
});

router.get("/me", (req, res) => {
  if (!isAuthenticated(req)) {
    res.status(401).json({ success: false, authenticated: false });
    return;
  }
  res.json({ success: true, authenticated: true });
});

export default router;
