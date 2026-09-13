import { describe, expect, it } from "vitest";
import { commandInferenceContentPaths, inferRepositoryCommands } from "./command-inference.js";

describe("repository command inference", () => {
  it("uses repository package scripts and the detected package manager", () => {
    const commands = inferRepositoryCommands([
      { path: "pnpm-lock.yaml" },
      { path: "package.json", content: JSON.stringify({ scripts: { "dev:web": "vite", server: "tsx server.ts", test: "vitest" } }) },
    ]);

    expect(commands).toMatchObject({
      installCommand: "pnpm install",
      frontendCommand: "pnpm run dev:web",
      backendCommand: "pnpm run server",
      testCommand: "pnpm run test",
      detectedFrom: ["package.json"],
      inferenceMethod: "deterministic",
    });
  });

  it("detects separate JavaScript frontend and Python backend commands", () => {
    const commands = inferRepositoryCommands([
      { path: "apps/web/package-lock.json" },
      { path: "apps/web/package.json", content: JSON.stringify({ scripts: { dev: "vite" }, dependencies: { react: "latest" } }) },
      { path: "backend/requirements.txt" },
      { path: "backend/app/main.py" },
      { path: "backend/tests/test_api.py" },
    ]);

    expect(commands).toMatchObject({
      installCommand: "(cd 'apps/web' && npm install) && (cd 'backend' && python -m pip install -r 'requirements.txt')",
      frontendCommand: "(cd 'apps/web' && npm run dev)",
      backendCommand: "(cd 'backend' && python -m uvicorn app.main:app --reload)",
      testCommand: "(cd 'backend' && python -m pytest -q)",
    });
    expect(commands.detectedFrom).toEqual(expect.arrayContaining(["apps/web/package.json", "backend/requirements.txt", "backend/app/main.py"]));
  });

  it("does not infer npm's failing placeholder test", () => {
    const commands = inferRepositoryCommands([
      { path: "package.json", content: JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) },
      { path: "package-lock.json" },
    ]);
    expect(commands.testCommand).toBeNull();
  });

  it("only requests bounded, shallow package manifests from GitHub", () => {
    expect(commandInferenceContentPaths(["package.json", "apps/web/package.json", "one/two/three/package.json", "README.md"]))
      .toEqual(["package.json", "README.md", "apps/web/package.json", "one/two/three/package.json"]);
  });

  it("uses conventional Makefile targets when package metadata is absent", () => {
    expect(inferRepositoryCommands([{ path: "Makefile", content: "setup:\n\tuv sync\nserver:\n\tuv run app.py\ncheck:\n\tpytest\n" }])).toMatchObject({
      installCommand: "make setup",
      backendCommand: "make server",
      testCommand: "make check",
      detectedFrom: ["Makefile"],
    });
  });
});
