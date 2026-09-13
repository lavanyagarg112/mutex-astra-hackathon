import { describe, expect, it } from "vitest";
import { queueDisplayOrder, type QueueComparable } from "./queue.js";

function task(overrides: Partial<QueueComparable>): QueueComparable {
  return { status: "QUEUED", queuePriority: 0, queueSequence: 1, completedAt: null, ...overrides };
}

describe("canonical queue display order", () => {
  it("puts a later refinement ahead of older normal requests", () => {
    const normal = task({ queuePriority: 0, queueSequence: 1 });
    const refinement = task({ queuePriority: 100, queueSequence: 9 });
    expect([normal, refinement].sort(queueDisplayOrder)).toEqual([refinement, normal]);
  });

  it("uses explicit queue sequence, never a creation timestamp", () => {
    const first = task({ queueSequence: 4 });
    const second = task({ queueSequence: 5 });
    expect([second, first].sort(queueDisplayOrder)).toEqual([first, second]);
  });

  it("keeps the active task above pending work", () => {
    const active = task({ status: "EDITING", queueSequence: 99 });
    const refinement = task({ queuePriority: 100, queueSequence: 1 });
    expect([refinement, active].sort(queueDisplayOrder)).toEqual([active, refinement]);
  });
});

