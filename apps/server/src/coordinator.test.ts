import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICoordinator } from "./coordinator.js";

afterEach(() => vi.unstubAllGlobals());

describe("OpenAICoordinator", () => {
  it("returns a structured OpenAI refinement decision", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output_text: JSON.stringify({ kind: "REFINEMENT", confidence: 0.94, reason: "It changes the active feature." }),
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const decision = await new OpenAICoordinator().classify({
      activeRequest: "Add sign in",
      incoming: "Redirect to the dashboard afterward",
      apiKey: "test-key",
      model: "gpt-5-mini",
    });

    expect(decision).toEqual({ kind: "REFINEMENT", confidence: 0.94, reason: "It changes the active feature." });
    const request = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as { model: string; store: boolean; text: { format: { type: string } } };
    expect(request).toMatchObject({ model: "gpt-5-mini", store: false, text: { format: { type: "json_schema" } } });
  });

  it("keeps work separate when OpenAI is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "unavailable" } }), { status: 503 })));

    const decision = await new OpenAICoordinator().classify({
      activeRequest: "Add sign in",
      incoming: "Build a billing page",
      apiKey: "test-key",
      model: "gpt-5-mini",
    });

    expect(decision.kind).toBe("INDEPENDENT");
    expect(decision.confidence).toBe(0);
  });
});
