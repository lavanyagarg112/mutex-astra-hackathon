import type { TaskStatus } from "@prisma/client";
import { activeStatuses } from "@relaycode/shared";

export type QueueComparable = {
  status: TaskStatus;
  queuePriority: number;
  queueSequence: number;
  completedAt: Date | null;
};

/** Active first, pending in canonical execution order, history newest first. */
export function queueDisplayOrder(a: QueueComparable, b: QueueComparable) {
  const active = activeStatuses as TaskStatus[];
  const aActive = active.includes(a.status);
  const bActive = active.includes(b.status);
  if (aActive !== bActive) return aActive ? -1 : 1;
  const aPending = ["QUEUED", "WAITING_FOR_REQUESTER"].includes(a.status);
  const bPending = ["QUEUED", "WAITING_FOR_REQUESTER"].includes(b.status);
  if (aPending !== bPending) return aPending ? -1 : 1;
  if (aPending && bPending) return b.queuePriority - a.queuePriority || a.queueSequence - b.queueSequence;
  return (b.completedAt?.valueOf() ?? 0) - (a.completedAt?.valueOf() ?? 0);
}

