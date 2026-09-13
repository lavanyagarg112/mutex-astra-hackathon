import { describe, expect, it } from "vitest";
import { commandWithPreviewPort, localPreviewUrl } from "../src/processes.js";

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

describe("preview port allocation", () => {
  it("overrides common explicit server ports", () => {
    expect(commandWithPreviewPort("python -m uvicorn app.main:app --reload --port 8000", 8341)).toContain("--port 8341");
    expect(commandWithPreviewPort("npm run dev -- --port=5173", 3341)).toContain("--port=3341");
    expect(commandWithPreviewPort("python manage.py runserver 8000", 8341)).toContain("runserver 127.0.0.1:8341");
  });

  it("adds supported framework port flags", () => {
    expect(commandWithPreviewPort("vite", 3456)).toBe("vite --port 3456");
    expect(commandWithPreviewPort("(cd backend && uvicorn app.main:app --reload)", 8456)).toBe("(cd backend && uvicorn app.main:app --reload --port 8456)");
  });

  it("creates a local URL when a server reports only its allocated port", () => {
    expect(localPreviewUrl("API listening on port 8341", 8341)).toBe("http://localhost:8341/");
    expect(localPreviewUrl("Server ready", 3456)).toBe("http://localhost:3456/");
  });
});
