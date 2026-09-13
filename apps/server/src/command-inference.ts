import type { InferredCommands } from "@relaycode/shared";

export type RepositoryFile = { path: string; content?: string };

type PackageManifest = {
  path: string;
  directory: string;
  scripts: Record<string, string>;
  dependencies: Set<string>;
};

const frontendPackages = new Set(["react", "react-dom", "next", "vite", "vue", "@angular/core", "svelte", "astro"]);
const backendPackages = new Set(["express", "fastify", "@nestjs/core", "koa", "hapi", "@hapi/hapi"]);

/**
 * Infer only conventional, reviewable commands. Repository file contents never
 * become shell commands directly; package scripts are invoked by their names.
 */
export function inferRepositoryCommands(files: readonly RepositoryFile[]): InferredCommands {
  const paths = new Set(files.map((file) => normalizePath(file.path)));
  const manifests = files
    .filter((file) => normalizePath(file.path).endsWith("package.json") && file.content)
    .map(parsePackageManifest)
    .filter((manifest): manifest is PackageManifest => Boolean(manifest));

  const detectedFrom = new Set<string>();
  const installParts: string[] = [];

  const root = manifests.find((manifest) => manifest.directory === "");
  const installManifests = root ? [root] : manifests.filter((manifest) => manifest.directory.split("/").length <= 2);
  for (const manifest of installManifests) {
    detectedFrom.add(manifest.path);
    installParts.push(inDirectory(manifest.directory, `${packageManagerFor(manifest.directory, paths)} install`));
  }

  const requirements = [...paths]
    .filter((path) => /(^|\/)(requirements(?:-[a-z0-9_.-]+)?\.txt)$/i.test(path))
    .sort(pathPreference);
  for (const path of requirements) {
    detectedFrom.add(path);
    installParts.push(inDirectory(directoryOf(path), `python -m pip install -r ${shellQuote(baseName(path))}`));
  }

  const frontend = bestManifest(manifests, "frontend");
  const backend = bestManifest(manifests, "backend");

  let frontendCommand = commandForNamedScript(root, ["dev:web", "dev:frontend", "frontend", "web"], paths);
  let backendCommand = commandForNamedScript(root, ["dev:server", "dev:backend", "dev:api", "server", "backend", "api"], paths);

  if (!frontendCommand && frontend) frontendCommand = commandForNamedScript(frontend, ["dev", "start", "serve"], paths);
  if (!backendCommand && backend) backendCommand = commandForNamedScript(backend, ["dev", "start", "serve"], paths);
  if (frontendCommand && frontend) detectedFrom.add(frontend.path);
  if (backendCommand && backend) detectedFrom.add(backend.path);

  if (!frontendCommand && root && hasAny(root.dependencies, frontendPackages)) {
    frontendCommand = commandForNamedScript(root, ["dev", "start", "serve"], paths);
  }
  if (!backendCommand && root && hasAny(root.dependencies, backendPackages)) {
    backendCommand = commandForNamedScript(root, ["start", "dev", "serve"], paths);
  }

  const pythonRoot = inferPythonRoot(paths);
  if (!backendCommand && pythonRoot) {
    const inferredBackend = inferPythonBackendCommand(pythonRoot, paths);
    backendCommand = inferredBackend?.command ?? null;
    if (inferredBackend) detectedFrom.add(inferredBackend.marker);
  }

  let testCommand = commandForNamedScript(root, ["test", "check"], paths);
  if (testCommand && root?.scripts.test && isPlaceholderTest(root.scripts.test)) testCommand = null;
  if (!testCommand) {
    const testManifest = [...manifests]
      .sort((a, b) => pathPreference(a.path, b.path))
      .find((manifest) => manifest.scripts.test && !isPlaceholderTest(manifest.scripts.test));
    testCommand = testManifest ? commandForNamedScript(testManifest, ["test"], paths) : null;
    if (testCommand && testManifest) detectedFrom.add(testManifest.path);
  }
  if (!testCommand) {
    const pytestDirectory = findPythonTestDirectory(paths);
    if (pytestDirectory !== null) {
      testCommand = inDirectory(pytestDirectory, "python -m pytest -q");
      const marker = [...paths].find((path) => path === joinPath(pytestDirectory, "pytest.ini") || path === joinPath(pytestDirectory, "pyproject.toml") || path.startsWith(joinPath(pytestDirectory, "tests/")!));
      if (marker) detectedFrom.add(marker);
    }
  }

  if (manifests.length === 0 && paths.has("Cargo.toml")) {
    detectedFrom.add("Cargo.toml");
    return withDiagnostics({ installCommand: null, frontendCommand: null, backendCommand: "cargo run", testCommand: "cargo test", detectedFrom: [...detectedFrom] });
  }
  if (manifests.length === 0 && paths.has("go.mod")) {
    detectedFrom.add("go.mod");
    return withDiagnostics({ installCommand: "go mod download", frontendCommand: null, backendCommand: "go run .", testCommand: "go test ./...", detectedFrom: [...detectedFrom] });
  }

  const makefile = files.find((file) => /(^|\/)Makefile$/i.test(normalizePath(file.path)) && file.content);
  if (makefile) {
    const targets = new Set([...makefile.content!.matchAll(/^([A-Za-z0-9_.-]+)\s*:(?![=])/gm)].map((match) => match[1]));
    const makeDirectory = directoryOf(normalizePath(makefile.path));
    const make = (names: string[]) => {
      const target = names.find((name) => targets.has(name));
      return target ? inDirectory(makeDirectory, `make ${target}`) : null;
    };
    if (installParts.length === 0) {
      const command = make(["install", "setup", "bootstrap"]);
      if (command) installParts.push(command);
    }
    frontendCommand ??= make(["frontend", "web", "client"]);
    backendCommand ??= make(["backend", "server", "api", "dev", "run"]);
    testCommand ??= make(["test", "tests", "check", "validate"]);
    if (installParts.length || frontendCommand || backendCommand || testCommand) detectedFrom.add(normalizePath(makefile.path));
  }

  const composePath = [...paths].find((path) => /(^|\/)(?:compose|docker-compose)\.ya?ml$/i.test(path));
  if (composePath && !frontendCommand && !backendCommand) {
    backendCommand = inDirectory(directoryOf(composePath), "docker compose up");
    detectedFrom.add(composePath);
  }

  return withDiagnostics({
    installCommand: unique(installParts).join(" && ") || null,
    frontendCommand,
    backendCommand,
    testCommand,
    detectedFrom: [...detectedFrom].sort(pathPreference),
  });
}

/** Files whose contents are needed in addition to the Git tree path list. */
export function commandInferenceContentPaths(paths: readonly string[]) {
  const useful = /(^|\/)(package\.json|README(?:\.[a-z0-9_-]+)?|Makefile|compose\.ya?ml|docker-compose\.ya?ml|pyproject\.toml|requirements(?:-[a-z0-9_.-]+)?\.txt|Pipfile|poetry\.lock|pnpm-workspace\.yaml|turbo\.json|nx\.json|Procfile|Taskfile\.ya?ml|\.env\.example)$/i;
  const workflows = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
  return paths
    .map(normalizePath)
    .filter((path) => (useful.test(path) && path.split("/").length <= 5) || workflows.test(path))
    .sort(pathPreference)
    .slice(0, 50);
}

function withDiagnostics(commands: Omit<InferredCommands, "inferenceMethod" | "diagnostics">): InferredCommands {
  const found = [commands.installCommand, commands.frontendCommand, commands.backendCommand, commands.testCommand].filter(Boolean).length;
  return {
    ...commands,
    inferenceMethod: "deterministic",
    diagnostics: [found ? `Detected ${found} of 4 commands from repository conventions.` : "No conventional commands were detected."],
  };
}

function parsePackageManifest(file: RepositoryFile): PackageManifest | null {
  try {
    const parsed = JSON.parse(file.content!) as { scripts?: unknown; dependencies?: unknown; devDependencies?: unknown };
    const scripts = isRecord(parsed.scripts)
      ? Object.fromEntries(Object.entries(parsed.scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {};
    const dependencies = new Set([
      ...(isRecord(parsed.dependencies) ? Object.keys(parsed.dependencies) : []),
      ...(isRecord(parsed.devDependencies) ? Object.keys(parsed.devDependencies) : []),
    ]);
    const path = normalizePath(file.path);
    return { path, directory: directoryOf(path), scripts, dependencies };
  } catch {
    return null;
  }
}

function bestManifest(manifests: PackageManifest[], kind: "frontend" | "backend") {
  const packageHints = kind === "frontend" ? frontendPackages : backendPackages;
  const directoryPattern = kind === "frontend" ? /(^|\/)(web|frontend|front-end|client|ui)(\/|$)/i : /(^|\/)(server|backend|back-end|api)(\/|$)/i;
  return manifests
    .map((manifest) => ({ manifest, score: (directoryPattern.test(manifest.directory) ? 10 : 0) + (hasAny(manifest.dependencies, packageHints) ? 5 : 0) - manifest.path.split("/").length }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || pathPreference(a.manifest.path, b.manifest.path))[0]?.manifest;
}

function commandForNamedScript(manifest: PackageManifest | undefined, names: string[], paths: Set<string>): string | null {
  if (!manifest) return null;
  const name = names.find((candidate) => manifest.scripts[candidate]);
  if (!name) return null;
  const manager = packageManagerFor(manifest.directory, paths);
  const command = manager === "yarn" ? `yarn ${name}` : `${manager} run ${name}`;
  return inDirectory(manifest.directory, command);
}

function packageManagerFor(directory: string, paths: Set<string>) {
  const ancestors = [directory];
  let current = directory;
  while (current.includes("/")) {
    current = directoryOf(current);
    ancestors.push(current);
  }
  if (!ancestors.includes("")) ancestors.push("");
  for (const ancestor of ancestors) {
    if (paths.has(joinPath(ancestor, "pnpm-lock.yaml"))) return "pnpm";
    if (paths.has(joinPath(ancestor, "yarn.lock"))) return "yarn";
    if (paths.has(joinPath(ancestor, "bun.lock")) || paths.has(joinPath(ancestor, "bun.lockb"))) return "bun";
    if (paths.has(joinPath(ancestor, "package-lock.json"))) return "npm";
  }
  return "npm";
}

function inferPythonRoot(paths: Set<string>): { directory: string; marker: string } | null {
  const marker = [...paths].sort(pathPreference).find((path) => /(^|\/)(manage\.py|pyproject\.toml|requirements(?:-[a-z0-9_.-]+)?\.txt)$/i.test(path));
  return marker ? { directory: directoryOf(marker), marker } : null;
}

function inferPythonBackendCommand(root: { directory: string }, paths: Set<string>) {
  const djangoMarker = joinPath(root.directory, "manage.py");
  const fastApiMarker = joinPath(root.directory, "app/main.py");
  const pythonMarker = joinPath(root.directory, "main.py");
  if (paths.has(djangoMarker)) return { command: inDirectory(root.directory, "python manage.py runserver"), marker: djangoMarker };
  if (paths.has(fastApiMarker)) return { command: inDirectory(root.directory, "python -m uvicorn app.main:app --reload"), marker: fastApiMarker };
  if (paths.has(pythonMarker)) return { command: inDirectory(root.directory, "python main.py"), marker: pythonMarker };
  return null;
}

function findPythonTestDirectory(paths: Set<string>): string | null {
  const testPath = [...paths].sort(pathPreference).find((path) => /(^|\/)tests\//.test(path));
  if (testPath) return directoryOf(testPath.slice(0, testPath.indexOf("tests/") + "tests".length));
  const config = [...paths].sort(pathPreference).find((path) => /(^|\/)(pytest\.ini|tox\.ini)$/.test(path));
  return config ? directoryOf(config) : null;
}

function inDirectory(directory: string, command: string) {
  return directory ? `(cd ${shellQuote(directory)} && ${command})` : command;
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function normalizePath(path: string) {
  return path.replace(/^\.\//, "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function directoryOf(path: string) {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

function baseName(path: string) {
  return path.slice(path.lastIndexOf("/") + 1);
}

function joinPath(directory: string, name: string) {
  return directory ? `${directory}/${name}` : name;
}

function pathPreference(a: string, b: string) {
  return a.split("/").length - b.split("/").length || a.localeCompare(b);
}

function hasAny(values: Set<string>, candidates: Set<string>) {
  return [...candidates].some((candidate) => values.has(candidate));
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function isPlaceholderTest(script: string | undefined) {
  return !script || /no test specified|exit 1/i.test(script);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
