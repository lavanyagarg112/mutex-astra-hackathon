import { createHmac, randomBytes } from "node:crypto";
import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { createAuthMiddleware, demoAuthEnabled, hashToken, HttpError, readCookie, routeError, safeEqual, secureCookie, SESSION_COOKIE, type AuthenticatedRequest } from "./auth.js";
import { encryptSecret, decryptSecret } from "./secrets.js";
import { exchangeOAuthCode, getGitHubUser } from "./github.js";
import { serializeUser } from "./serialize.js";

const OAUTH_COOKIE = "relaycode_oauth_state";
const sessionMaxAgeSeconds = 60 * 60 * 24 * 30;

export function createAuthRouter(prisma: PrismaClient) {
  const router = Router();

  router.get("/github", (req, res) => {
    try {
      const clientId = process.env.GITHUB_CLIENT_ID;
      if (!clientId) throw new HttpError(503, "GitHub login is not configured");
      const state = randomBytes(24).toString("base64url");
      const returnTo = safeReturnTo(typeof req.query.returnTo === "string" ? req.query.returnTo : undefined);
      const payload = Buffer.from(JSON.stringify({ state, returnTo }), "utf8").toString("base64url");
      res.cookie(OAUTH_COOKIE, `${payload}.${sign(payload)}`, { httpOnly: true, secure: secureCookie(), sameSite: "lax", maxAge: 10 * 60 * 1000, path: "/api/auth/github/callback" });
      const authorize = new URL("https://github.com/login/oauth/authorize");
      authorize.searchParams.set("client_id", clientId);
      authorize.searchParams.set("state", state);
      if (process.env.GITHUB_CALLBACK_URL) authorize.searchParams.set("redirect_uri", process.env.GITHUB_CALLBACK_URL);
      authorize.searchParams.set("scope", process.env.GITHUB_OAUTH_SCOPE?.trim() || "read:user repo");
      return res.redirect(authorize.toString());
    } catch (error) { return routeError(res, error); }
  });

  router.get("/github/callback", async (req, res) => {
    try {
      const code = typeof req.query.code === "string" ? req.query.code : "";
      const state = typeof req.query.state === "string" ? req.query.state : "";
      const cookie = readCookie(req.headers.cookie, OAUTH_COOKIE);
      const oauth = cookie ? verifyState(state, cookie) : null;
      if (!code || !state || !oauth) throw new HttpError(400, "GitHub sign-in expired or could not be verified. Please try again.");
      const token = await exchangeOAuthCode(code);
      const github = await getGitHubUser(token);
      const existing = await prisma.user.findUnique({ where: { githubId: String(github.id) } });
      const usernameOwner = await prisma.user.findUnique({ where: { username: github.login.toLowerCase() } });
      const username = usernameOwner && usernameOwner.id !== existing?.id ? `${github.login.toLowerCase()}-${github.id}` : github.login.toLowerCase();
      const user = existing
        ? await prisma.user.update({ where: { id: existing.id }, data: { name: github.name || github.login, username, githubLogin: github.login, avatarUrl: github.avatar_url, githubToken: encryptSecret(token) } })
        : await prisma.user.create({ data: { id: `github-${github.id}`, name: github.name || github.login, username, githubId: String(github.id), githubLogin: github.login, avatarUrl: github.avatar_url, githubToken: encryptSecret(token) } });
      const rawSession = randomBytes(32).toString("base64url");
      await prisma.authSession.create({ data: { tokenHash: hashToken(rawSession), userId: user.id, expiresAt: new Date(Date.now() + sessionMaxAgeSeconds * 1000) } });
      res.clearCookie(OAUTH_COOKIE, { path: "/api/auth/github/callback" });
      res.cookie(SESSION_COOKIE, rawSession, { httpOnly: true, secure: secureCookie(), sameSite: "lax", maxAge: sessionMaxAgeSeconds * 1000, path: "/" });
      return res.redirect(`${process.env.WEB_ORIGIN ?? "http://localhost:5173"}${oauth.returnTo}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "GitHub sign-in failed";
      return res.redirect(`${process.env.WEB_ORIGIN ?? "http://localhost:5173"}/auth/callback?error=${encodeURIComponent(message)}`);
    }
  });

  router.post("/login", async (req, res) => {
    try {
      if (!demoAuthEnabled()) throw new HttpError(404, "Demo login is disabled");
      const username = typeof req.body?.username === "string" ? req.body.username.trim().toLowerCase() : "";
      if (!username) throw new HttpError(400, "Username is required");
      const user = await prisma.user.findUnique({ where: { username } });
      if (!user) throw new HttpError(401, "Unknown username");
      return res.json({ user: serializeUser(user), demoUserId: user.id });
    } catch (error) { return routeError(res, error); }
  });

  router.get("/session", createAuthMiddleware(prisma), async (req: AuthenticatedRequest, res) => {
    const user = await prisma.user.findUnique({ where: { id: req.userId! } });
    if (!user) return res.status(401).json({ error: "Unknown user" });
    return res.json({ user: serializeUser(user), provider: req.authMethod === "session" ? "github" : "demo" });
  });

  router.post("/logout", async (req, res) => {
    const raw = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (raw) await prisma.authSession.deleteMany({ where: { tokenHash: hashToken(raw) } });
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    return res.status(204).end();
  });

  return router;
}

export function githubTokenFor(user: { githubToken: string | null }) {
  if (!user.githubToken) throw new HttpError(409, "Connect your GitHub account before selecting or joining a repository.");
  return decryptSecret(user.githubToken);
}

function sign(value: string) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new HttpError(503, "GitHub login is not configured: SESSION_SECRET is missing");
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function verifyState(state: string, cookie: string): { returnTo: string } | null {
  const [payload, signature] = cookie.split(".");
  if (!payload || !signature || !safeEqual(sign(payload), signature)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { state?: unknown; returnTo?: unknown };
    if (typeof decoded.state !== "string" || !safeEqual(state, decoded.state)) return null;
    return { returnTo: safeReturnTo(typeof decoded.returnTo === "string" ? decoded.returnTo : undefined) };
  } catch { return null; }
}

function safeReturnTo(value: string | undefined) {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.length > 2_000) return "/auth/callback";
  return value;
}
