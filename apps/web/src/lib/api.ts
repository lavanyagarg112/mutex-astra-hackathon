import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@relaycode/shared";

export const API_URL = import.meta.env.VITE_API_URL ?? "";
const storageKey = "relaycode.userId";

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
    const message = await response.text().catch(() => response.statusText);
    const error = new Error(message || `Request failed (${response.status})`) as Error & { status: number };
    error.status = response.status;
    throw error;
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

export async function loginWithUsername(username: string): Promise<string> {
  const normalized = username.trim().toLowerCase();
  try {
    const response = await fetch(`${API_URL}/api/auth/login`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: normalized }),
    });
    if (!response.ok) throw new Error("Unknown username");
    const payload = await response.json() as { user: { id: string } };
    setActiveUserId(payload.user.id);
    return payload.user.id;
  } catch (error) {
    if (["alice", "bob", "charlie"].includes(normalized)) {
      setActiveUserId(normalized);
      return normalized;
    }
    throw error;
  }
}

export function beginGithubLogin(): void {
  const returnTo = `${window.location.pathname}${window.location.search}`;
  window.localStorage.setItem("relaycode.authReturnTo", returnTo);
  window.location.assign(`${API_URL}/api/auth/github?returnTo=${encodeURIComponent(returnTo)}`);
}
