export type CoordinatorDecision = { kind: "REFINEMENT" | "INDEPENDENT"; confidence: number; reason: string };

export interface CoordinatorAgent {
  classify(input: { incoming: string; activeRequest: string }): Promise<CoordinatorDecision>;
}

/** Conservative demo coordinator. Replace this behind the interface with a small model. */
export class ConservativeCoordinator implements CoordinatorAgent {
  async classify({ incoming }: { incoming: string; activeRequest: string }): Promise<CoordinatorDecision> {
    const explicitContinuation = /^(also|and also|one more thing|actually|instead|make (?:it|that)|put (?:it|that)|for that)\b/i.test(incoming.trim());
    return explicitContinuation
      ? { kind: "REFINEMENT", confidence: 0.91, reason: "Explicit continuation language" }
      : { kind: "INDEPENDENT", confidence: 0.55, reason: "Low-confidence requests remain independent" };
  }
}

