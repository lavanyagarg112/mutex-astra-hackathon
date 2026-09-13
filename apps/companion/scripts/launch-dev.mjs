import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const appDirectory = fileURLToPath(new URL("..", import.meta.url));

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: appDirectory, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Companion stopped by ${signal}`));
      else if (code === 0) resolve();
      else reject(new Error(`Companion exited with code ${code}`));
    });
  });
}

if (process.platform !== "darwin") {
  await run(require("electron"), [appDirectory]);
} else {
  // macOS associates URL schemes with application bundles, not an Electron
  // executable plus command-line arguments. Build an unpacked local bundle so
  // relaycode:// links reopen Relaycode Companion instead of Electron's demo.
  const builderCli = require.resolve("electron-builder/out/cli/cli.js");
  await run(process.execPath, [builderCli, "--mac", "dir", "--publish", "never"]);

  const releaseDirectory = join(appDirectory, "release");
  const output = await readdir(releaseDirectory, { withFileTypes: true });
  const expectedDirectory = process.arch === "arm64" ? "mac-arm64" : "mac";
  const macDirectory = output.find((entry) => entry.isDirectory() && entry.name === expectedDirectory)
    ?? output.find((entry) => entry.isDirectory() && entry.name.startsWith("mac"));
  if (!macDirectory) throw new Error("Could not find the packaged Relaycode Companion application.");

  const executable = join(
    releaseDirectory,
    macDirectory.name,
    "Relaycode Companion.app",
    "Contents",
    "MacOS",
    "Relaycode Companion",
  );
  await run(executable, []);
}
