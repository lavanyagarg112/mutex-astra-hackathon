/**
 * Tracks which users currently have an open browser tab on a project,
 * separate from `scheduler.connections` which tracks the local companion
 * (daemon) connection. Ref-counted so multiple tabs for the same user don't
 * flip them offline until the last one closes.
 */
export class BrowserPresence {
  private counts = new Map<string, Map<string, number>>();

  join(projectId: string, userId: string): boolean {
    const users = this.counts.get(projectId) ?? new Map<string, number>();
    const next = (users.get(userId) ?? 0) + 1;
    users.set(userId, next);
    this.counts.set(projectId, users);
    return next === 1;
  }

  leave(projectId: string, userId: string): boolean {
    const users = this.counts.get(projectId);
    if (!users) return false;
    const next = (users.get(userId) ?? 0) - 1;
    if (next <= 0) {
      users.delete(userId);
      return true;
    }
    users.set(userId, next);
    return false;
  }

  isOnline(projectId: string, userId: string): boolean {
    return (this.counts.get(projectId)?.get(userId) ?? 0) > 0;
  }
}
