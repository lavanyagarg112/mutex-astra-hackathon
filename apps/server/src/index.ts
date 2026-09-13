import "dotenv/config";
import { createServer } from "node:http";
import cors from "cors";
import express from "express";
import { Server } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@relaycode/shared";
import { prisma } from "./db.js";
import { createApiRouter } from "./routes.js";
import { ConnectionRegistry, type RelayServer } from "./realtime.js";
import { RuntimeState } from "./runtime.js";
import { Scheduler } from "./scheduler.js";
import { installSocketHandlers } from "./socket.js";
import { serializeUser } from "./serialize.js";

const app = express();
const httpServer = createServer(app);
const origin = process.env.WEB_ORIGIN ?? "http://localhost:5173";
const io: RelayServer = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, { cors: { origin, credentials: true }, maxHttpBufferSize: 2_500_000 });
const runtime = new RuntimeState();
const scheduler = new Scheduler(prisma, io, new ConnectionRegistry());

app.disable("x-powered-by");
app.use(cors({ origin, credentials: true }));
app.use(express.json({ limit: "2mb" }));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.post("/api/auth/login", async (req, res) => {
  const username = typeof req.body?.username === "string" ? req.body.username.trim().toLowerCase() : "";
  if (!username) return res.status(400).json({ error: "Username is required" });
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) return res.status(401).json({ error: "Unknown username" });
  return res.json({ user: serializeUser(user), demoUserId: user.id });
});
app.use("/api", createApiRouter(prisma, io, scheduler, runtime));
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

installSocketHandlers(io, prisma, scheduler, runtime);

const port = Number(process.env.PORT ?? 4100);
httpServer.listen(port, () => console.log(`RelayCode server listening on http://localhost:${port}`));

async function shutdown() {
  io.close();
  httpServer.close();
  await prisma.$disconnect();
}
process.on("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
