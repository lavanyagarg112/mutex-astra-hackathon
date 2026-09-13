import "dotenv/config";
import { createServer } from "node:http";
import { resolve } from "node:path";
import cors from "cors";
import express from "express";
import { Server } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@relaycode/shared";
import { createAuthRouter } from "./auth-routes.js";
import { prisma } from "./db.js";
import { createApiRouter } from "./routes.js";
import { ConnectionRegistry, type RelayServer } from "./realtime.js";
import { BrowserPresence } from "./presence.js";
import { RuntimeState } from "./runtime.js";
import { Scheduler } from "./scheduler.js";
import { installSocketHandlers } from "./socket.js";

const app = express();
const httpServer = createServer(app);
const origin = process.env.WEB_ORIGIN ?? "http://localhost:5173";
const io: RelayServer = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, { cors: { origin, credentials: true }, maxHttpBufferSize: 2_500_000 });
const runtime = new RuntimeState();
const scheduler = new Scheduler(prisma, io, new ConnectionRegistry());
const browserPresence = new BrowserPresence();

app.disable("x-powered-by");
app.use(cors({ origin, credentials: true }));
app.use(express.json({ limit: "2mb" }));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/api/companion/download", (req, res) => {
  const platform = String(req.query.platform ?? "").toLowerCase();
  const downloads: Record<string, string | undefined> = {
    darwin: process.env.COMPANION_DOWNLOAD_URL_MAC,
    mac: process.env.COMPANION_DOWNLOAD_URL_MAC,
    macos: process.env.COMPANION_DOWNLOAD_URL_MAC,
    win32: process.env.COMPANION_DOWNLOAD_URL_WINDOWS,
    windows: process.env.COMPANION_DOWNLOAD_URL_WINDOWS,
    linux: process.env.COMPANION_DOWNLOAD_URL_LINUX,
  };
  if (!(platform in downloads)) return res.status(400).json({ error: "Choose macOS, Windows, or Linux." });
  const url = downloads[platform];
  if (!url) return res.status(503).json({ error: `The ${platform === "win32" || platform === "windows" ? "Windows" : platform === "linux" ? "Linux" : "macOS"} companion download has not been published yet.` });
  return res.redirect(url);
});
app.use("/api/auth", createAuthRouter(prisma));
app.use("/api", createApiRouter(prisma, io, scheduler, runtime, browserPresence));
app.use("/api", (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled API error", error instanceof Error ? error.message : "Unknown error");
  res.status(500).json({ error: "Internal server error" });
});
if (process.env.NODE_ENV === "production") {
  const webRoot = resolve(process.cwd(), "apps/web/dist");
  app.use(express.static(webRoot));
  app.get("/{*path}", (_req, res) => res.sendFile(resolve(webRoot, "index.html")));
}
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

installSocketHandlers(io, prisma, scheduler, runtime, browserPresence);

const port = Number(process.env.PORT ?? 4100);
httpServer.listen(port, () => console.log(`RelayCode server listening on http://localhost:${port}`));

async function shutdown() {
  io.close();
  httpServer.close();
  await prisma.$disconnect();
}
process.on("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
