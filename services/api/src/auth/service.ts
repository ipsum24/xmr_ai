import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { config } from "../config";
import { prisma } from "../db";

export const SESSION_COOKIE = "wusdt_session";

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
}

export async function login(email: string, password: string, userAgent?: string) {
  const admin = await prisma.adminUser.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!admin?.passwordHash) throw new Error("invalid email or password");

  const ok = await bcrypt.compare(password, admin.passwordHash);
  if (!ok) throw new Error("invalid email or password");

  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3_600_000);

  await prisma.session.create({
    data: { id: sessionId, adminId: admin.id, expiresAt, userAgent: userAgent?.slice(0, 200) },
  });
  await prisma.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });
  await prisma.auditLog.create({
    data: { adminId: admin.id, action: "auth.login", detail: userAgent?.slice(0, 200) ?? null },
  });

  const token = jwt.sign({ sub: admin.id, jti: sessionId }, config.jwtSecret, {
    expiresIn: `${config.sessionTtlHours}h`,
  });

  return { token, sessionId, expiresAt, admin: { id: admin.id, email: admin.email, name: admin.name } };
}

/** Server-side revocation: the session row is marked, so the cookie dies now. */
export async function logout(sessionId: string): Promise<void> {
  await prisma.session
    .update({ where: { id: sessionId }, data: { revokedAt: new Date() } })
    .catch(() => undefined);
}

export async function resolveSession(token: string | undefined) {
  if (!token) return null;
  let payload: { sub: string; jti: string };
  try {
    payload = jwt.verify(token, config.jwtSecret) as { sub: string; jti: string };
  } catch {
    return null;
  }

  const session = await prisma.session.findUnique({ where: { id: payload.jti }, include: { admin: true } });
  if (!session || session.revokedAt || session.expiresAt.getTime() < Date.now()) return null;

  return { sessionId: session.id, admin: session.admin };
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: config.nodeEnv === "production",
    path: "/",
    maxAge: config.sessionTtlHours * 3_600_000,
  };
}
