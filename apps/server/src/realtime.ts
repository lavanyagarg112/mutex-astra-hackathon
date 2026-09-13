import type { Server, Socket } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents, SyncProjectPayload } from "@relaycode/shared";

export type RelayServer = Server<ClientToServerEvents, ServerToClientEvents>;
export type RelaySocket = Socket<ClientToServerEvents, ServerToClientEvents>;

type DaemonSession = {
  socket: RelaySocket;
  userId: string;
  version: string;
  mappings: Map<string, { path: string; remoteUrl?: string }>;
  readyProjects: Set<string>;
  lastSeenAt: number;
};

export class ConnectionRegistry {
  private readonly sessions = new Map<string, DaemonSession>();
  private readonly byUser = new Map<string, Set<string>>();

  register(socket: RelaySocket, data: { userId: string; version: string; mappings: Array<{ projectId: string; path: string; remoteUrl?: string }> }) {
    this.unregister(socket.id);
    const session: DaemonSession = {
      socket,
      userId: data.userId,
      version: data.version,
      mappings: new Map(data.mappings.map((mapping) => [mapping.projectId, mapping])),
      readyProjects: new Set(),
      lastSeenAt: Date.now(),
    };
    this.sessions.set(socket.id, session);
    const ids = this.byUser.get(data.userId) ?? new Set<string>();
    ids.add(socket.id);
    this.byUser.set(data.userId, ids);
    socket.data.daemonUserId = data.userId;
    return session;
  }

  unregister(socketId: string) {
    const session = this.sessions.get(socketId);
    if (!session) return null;
    this.sessions.delete(socketId);
    const ids = this.byUser.get(session.userId);
    ids?.delete(socketId);
    if (ids?.size === 0) this.byUser.delete(session.userId);
    return session;
  }

  heartbeat(socketId: string) {
    const session = this.sessions.get(socketId);
    if (session) session.lastSeenAt = Date.now();
  }

  get(socketId: string) {
    return this.sessions.get(socketId);
  }

  isOnline(userId: string) {
    return Boolean(this.byUser.get(userId)?.size);
  }

  isEligible(userId: string, projectId: string) {
    return this.userSessions(userId).some((session) => session.mappings.has(projectId) && session.readyProjects.has(projectId));
  }

  hasMapping(userId: string, projectId: string) {
    return this.userSessions(userId).some((session) => session.mappings.has(projectId));
  }

  markReady(socketId: string, projectId: string, ready: boolean) {
    const session = this.sessions.get(socketId);
    if (!session) return;
    if (ready) session.readyProjects.add(projectId);
    else session.readyProjects.delete(projectId);
  }

  markUserProjectUnready(userId: string, projectId: string) {
    for (const session of this.userSessions(userId)) session.readyProjects.delete(projectId);
  }

  emitToEligible(userId: string, projectId: string, event: keyof ServerToClientEvents, payload: unknown) {
    const session = this.userSessions(userId).find((item) => item.mappings.has(projectId) && item.readyProjects.has(projectId));
    if (!session) return false;
    const emit = session.socket.emit.bind(session.socket) as unknown as (name: keyof ServerToClientEvents, value: unknown) => void;
    emit(event, payload);
    return true;
  }

  emitToMapped(userId: string, projectId: string, event: keyof ServerToClientEvents, payload: unknown) {
    const session = this.userSessions(userId).find((item) => item.mappings.has(projectId));
    if (!session) return false;
    const emit = session.socket.emit.bind(session.socket) as unknown as (name: keyof ServerToClientEvents, value: unknown) => void;
    emit(event, payload);
    return true;
  }

  syncAllProjectMembers(projectId: string, payload: SyncProjectPayload) {
    const users = new Set<string>();
    for (const session of this.sessions.values()) {
      if (!session.mappings.has(projectId)) continue;
      session.readyProjects.delete(projectId);
      users.add(session.userId);
      session.socket.emit("SYNC_PROJECT", payload);
    }
    return [...users];
  }

  statusFor(userId: string, projectId: string) {
    const sessions = this.userSessions(userId);
    const mapped = sessions.find((session) => session.mappings.has(projectId));
    return {
      online: sessions.length > 0,
      mapped: Boolean(mapped),
      synchronized: Boolean(mapped?.readyProjects.has(projectId)),
      version: mapped?.version ?? sessions[0]?.version ?? null,
      path: mapped?.mappings.get(projectId)?.path ?? null,
    };
  }

  private userSessions(userId: string) {
    const ids = this.byUser.get(userId);
    if (!ids) return [];
    return [...ids].map((id) => this.sessions.get(id)).filter((session): session is DaemonSession => Boolean(session));
  }
}
