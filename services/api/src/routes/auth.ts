import { Router } from "express";
import { z } from "zod";
import { login, logout, SESSION_COOKIE, sessionCookieOptions } from "../auth/service";
import { asyncHandler, requireAuth, type AuthedRequest } from "../http/context";

export const authRouter = Router();

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const result = await login(email, password, req.headers["user-agent"]);
    res.cookie(SESSION_COOKIE, result.token, sessionCookieOptions());
    res.json({ admin: result.admin, expiresAt: result.expiresAt });
  }),
);

authRouter.post(
  "/logout",
  asyncHandler(async (req: AuthedRequest, res) => {
    if (req.sessionId) await logout(req.sessionId);
    res.clearCookie(SESSION_COOKIE, { ...sessionCookieOptions(), maxAge: undefined });
    res.json({ ok: true });
  }),
);

authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json({ admin: req.admin });
  }),
);
