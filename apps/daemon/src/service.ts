import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@relaycode/shared";
import type { DaemonConfig } from "./config.js";
import { DaemonRuntime } from "./runtime.js";
import { sanitizeText } from "./sanitize.js";

export type CompanionStatus =
  | { state: "connecting" }
  | { state: "connected"; serverUrl: string; userId: string }
  | { state: "disconnected"; reason: string }
  | { state: "error"; message: string };

export interface RunningDaemon {
  close(): Promise<void>;
}

/** Shared runtime entry point used by both the headless CLI and desktop companion. */
export function startDaemon(config: DaemonConfig, onStatus: (status: CompanionStatus) => void = () => undefined): RunningDaemon {
  const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(config.serverUrl, {
    auth: { userId: config.userId, token: config.token, client: "daemon" },
    transports: ["websocket"],
    autoConnect: false,
    reconnection: true,
  });
  const runtime = new DaemonRuntime(config, socket);
  runtime.install();
  socket.on("connect", () => onStatus({ state: "connected", serverUrl: config.serverUrl, userId: config.userId }));
  socket.on("disconnect", (reason) => onStatus({ state: "disconnected", reason: sanitizeText(reason) }));
  socket.on("connect_error", (error) => onStatus({ state: "error", message: sanitizeText(error.message) }));
  onStatus({ state: "connecting" });
  socket.connect();
  return { close: () => runtime.close() };
}
