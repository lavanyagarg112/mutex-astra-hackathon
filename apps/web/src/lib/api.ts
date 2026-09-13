import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@relaycode/shared";

export const API_URL = import.meta.env.VITE_API_URL ?? "";
const storageKey = "relaycode.userId";

export class ApiError extends Error {
  readonly status: number;
  readonly details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

function defaultErrorMessage(status: number): string {
  if (status === 401) return "Your session has expired. Sign in again to continue.";
  if (status === 403) return "You do not have permission to perform this action.";
  if (status === 404) return "The requested item could not be found.";
  if (status >= 500) return "Mutex could not complete the request. Please try again.";
  return `Request failed (${status}).`;
}

async function readError(response: Response): Promise<ApiError> {
  const raw = await response.text().catch(() => "");
  let message = "";
  let details: unknown;

  if (raw) {
    try {
      const body = JSON.parse(raw) as { error?: unknown; message?: unknown; details?: unknown };
      message = typeof body.error === "string" ? body.error : typeof body.message === "string" ? body.message : "";
      details = body.details;
    } catch {
      // Avoid displaying an HTML proxy response or an unhelpful serialized object.
      if (!raw.trimStart().startsWith("<") && raw.length <= 500) message = raw.trim();
    }
  }

  return new ApiError(response.status, message || defaultErrorMessage(response.status), details);
}

export function getActiveUserId(): string {
  return window.localStorage.getItem(storageKey) ?? import.meta.env.VITE_DEMO_USER_ID ?? "";
}

export function setActiveUserId(userId: string): void {
  if (userId) window.localStorage.setItem(storageKey, userId);
  else window.localStorage.removeItem(storageKey);
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(getActiveUserId() ? { "x-user-id": getActiveUserId() } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return response.json() as Promise<T>;
}

export function connectSocket(): Socket<ServerToClientEvents, ClientToServerEvents> {
  return io(API_URL || window.location.origin, {
    auth: { userId: getActiveUserId() },
    withCredentials: true,
    transports: ["websocket", "polling"],
    reconnectionDelayMax: 3000,
  });
}

export async function logout(): Promise<void> {
  await fetch(`${API_URL}/api/auth/logout`, { method: "POST", credentials: "include" }).catch(() => undefined);
  setActiveUserId("");
  window.location.reload();
}

export function beginGithubLogin(): void {
  const returnTo = `${window.location.pathname}${window.location.search}`;
  window.localStorage.setItem("relaycode.authReturnTo", returnTo);
  window.location.assign(`${API_URL}/api/auth/github?returnTo=${encodeURIComponent(returnTo)}`);
}
