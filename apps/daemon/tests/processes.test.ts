import { describe, expect, it } from "vitest";
import { localPreviewUrl } from "../src/processes.js";

describe("localPreviewUrl", () => {
  it("reads the URL printed by common frontend development servers", () => {
    expect(localPreviewUrl("  Local:   http://localhost:5173/\n")).toBe("http://localhost:5173/");
    expect(localPreviewUrl("ready - started server on 0.0.0.0:3000, url: http://localhost:3000"))
      .toBe("http://localhost:3000/");
  });

  it("makes wildcard listener addresses browser reachable", () => {
    expect(localPreviewUrl("listening at http://0.0.0.0:8080/app"))
      .toBe("http://localhost:8080/app");
  });

  it("ignores non-local URLs", () => {
    expect(localPreviewUrl("documentation: https://example.com:443/docs")).toBeUndefined();
  });
});
