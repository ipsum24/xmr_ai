import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ZodError } from "zod";
import { resolveSession, SESSION_COOKIE } from "../auth/service";

export interface AuthedRequest extends Request {
  admin?: { id: string; email: string; name: string | null };
  sessionId?: string;
}

/** Everything in the console is behind a session — including the read routes. */
export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const session = await resolveSession(req.cookies?.[SESSION_COOKIE]);
  if (!session) {
    res.status(401).json({ error: "authentication required" });
    return;
  }
  req.admin = session.admin;
  req.sessionId = session.sessionId;
  next();
}

export function asyncHandler(
  handler: (req: AuthedRequest, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req as AuthedRequest, res, next).catch(next);
  };
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({ error: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ") });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error("[api] request failed:", message);
  res.status(400).json({ error: message });
}
