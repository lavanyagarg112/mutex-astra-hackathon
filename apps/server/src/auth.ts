import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import type { PrismaClient, ProjectRole } from "@prisma/client";

export type AuthMethod = "session" | "demo";
export type AuthenticatedRequest = Request & { userId?: string; authMethod?: AuthMethod };
export const SESSION_COOKIE = "relaycode_session";

export function demoAuthEnabled() {
  return process.env.ALLOW_DEMO_AUTH === "true" || (process.env.ALLOW_DEMO_AUTH !== "false" && process.env.NODE_ENV !== "production");
}

export function createAuthMiddleware(prisma: PrismaClient) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const authenticated = await resolveRequestUser(prisma, req);
      if (!authenticated) return res.status(401).json({ error: "Authentication required. Sign in with GitHub." });
      req.userId = authenticated.userId;
      req.authMethod = authenticated.method;
      next();
    } catch (error) { next(error); }
  };
}

export async function resolveRequestUser(prisma: PrismaClient, req: Pick<Request, "headers" | "query">) {
  const sessionToken = readCookie(req.headers.cookie, SESSION_COOKIE);
  if (sessionToken) {
    const session = await prisma.authSession.findUnique({ where: { tokenHash: hashToken(sessionToken) } });
    if (session && session.expiresAt > new Date()) return { userId: session.userId, method: "session" as const };
    if (session) await prisma.authSession.delete({ where: { id: session.id } }).catch(() => undefined);
  }
  if (!demoAuthEnabled()) return null;
  const header = req.headers["x-user-id"];
  const userId = (typeof header === "string" ? header : undefined) ?? (typeof req.query.userId === "string" ? req.query.userId : undefined);
  return userId ? { userId, method: "demo" as const } : null;
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function readCookie(header: string | undefined, name: string) {
  if (!header) return undefined;
  for (const item of header.split(";")) {
    const [key, ...parts] = item.trim().split("=");
    if (key === name) return decodeURIComponent(parts.join("="));
  }
  return undefined;
}

export function secureCookie() {
  return process.env.NODE_ENV === "production" || (process.env.PUBLIC_URL ?? "").startsWith("https://");
}

export function safeEqual(left: string, right: string) {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function requireMember(
  prisma: PrismaClient,
  projectId: string,
  userId: string,
  options: { write?: boolean; owner?: boolean } = {},
) {
  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    include: { user: true },
  });
  if (!member) throw new HttpError(403, "You are not a member of this project");
  if (options.write && !member.repositoryWrite) throw new HttpError(403, "Repository write access is required");
  if (options.owner && member.role !== ("OWNER" satisfies ProjectRole)) throw new HttpError(403, "Project owner access is required");
  return member;
}

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export function routeError(res: Response, error: unknown) {
  if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
  if (error instanceof Error && error.name === "ZodError") return res.status(400).json({ error: "Invalid request", details: error.message });
  console.error("Request failed", error instanceof Error ? error.message : "Unknown error");
  return res.status(500).json({ error: "Internal server error" });
}
