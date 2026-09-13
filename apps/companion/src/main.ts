import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { addProjectBinding, DaemonConfigSchema, loadConfig, saveConfig, type DaemonConfig } from "../../daemon/src/config.js";
import { sanitizeText } from "../../daemon/src/sanitize.js";
import { startDaemon, type CompanionStatus, type RunningDaemon } from "../../daemon/src/service.js";

type ProjectSummary = { id: string; name: string; repositoryUrl: string; repositoryName: string; branch: string };
type SetupInput = { serverUrl: string; username: string; daemonToken: string };

let window: BrowserWindow | undefined;
let running: RunningDaemon | undefined;
let currentStatus: CompanionStatus = { state: "disconnected", reason: "Not configured" };
let knownProjects: ProjectSummary[] = [];

const preloadFile = join(app.getAppPath(), "src", "preload.cjs");
const credentialDirectory = join(homedir(), ".relaycode");
const credentialFile = join(credentialDirectory, "github-token.bin");
const askPassFile = join(credentialDirectory, process.platform === "win32" ? "git-askpass.cmd" : "git-askpass.sh");

async function installGitCredential(token?: string) {
  await mkdir(credentialDirectory, { recursive: true, mode: 0o700 });
  if (token) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure credential storage is unavailable on this computer.");
    await writeFile(credentialFile, safeStorage.encryptString(token), { mode: 0o600 });
  }
  if (!existsSync(credentialFile) || !safeStorage.isEncryptionAvailable()) return;
  const encrypted = await readFile(credentialFile);
  process.env.RELAYCODE_GITHUB_TOKEN = safeStorage.decryptString(encrypted);
  const askPass = process.platform === "win32"
    ? '@echo off\necho %~1 | findstr /I "Username" >nul\nif %errorlevel%==0 (echo x-access-token) else (echo %RELAYCODE_GITHUB_TOKEN%)\n'
    : '#!/bin/sh\ncase "$1" in\n  *Username*) printf "%s\\n" "x-access-token" ;;\n  *Password*) printf "%s\\n" "$RELAYCODE_GITHUB_TOKEN" ;;\nesac\n';
  await writeFile(askPassFile, askPass, { mode: 0o700 });
  if (process.platform !== "win32") await chmod(askPassFile, 0o700);
  process.env.GIT_ASKPASS = askPassFile;
}

function notify(status: CompanionStatus) {
  currentStatus = status;
  window?.webContents.send("companion:status", status);
}

async function optionalConfig(): Promise<DaemonConfig | undefined> {
  try { return await loadConfig(); } catch { return undefined; }
}

async function restartDaemon(config: DaemonConfig) {
  await running?.close();
  running = startDaemon(config, notify);
}

async function api<T>(serverUrl: string, path: string, userId: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${serverUrl.replace(/\/$/, "")}/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-user-id": userId, ...init?.headers },
  });
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(body.error || `Relaycode returned ${response.status}`);
  return body as T;
}

async function companionApi<T>(config: DaemonConfig, path: string): Promise<T> {
  const response = await fetch(`${config.serverUrl.replace(/\/$/, "")}/api${path}`, {
    headers: {
      "x-relaycode-user-id": config.userId,
      "x-relaycode-daemon-token": config.token,
    },
  });
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(body.error || `Relaycode returned ${response.status}`);
  return body as T;
}

async function saveIdentity(input: SetupInput) {
  const serverUrl = new URL(input.serverUrl).origin;
  const login = await api<{ user: { id: string; username: string } }>(serverUrl, "/auth/login", "unused", {
    method: "POST", body: JSON.stringify({ username: input.username.trim().toLowerCase() }),
  });
  const current = await optionalConfig();
  const config = DaemonConfigSchema.parse({
    version: 1, serverUrl, userId: login.user.id, token: input.daemonToken,
    agent: current?.agent ?? { provider: "auto" }, projects: current?.projects ?? {},
  });
  await saveConfig(config);
  await restartDaemon(config);
  return publicState(config);
}

async function publicState(providedConfig?: DaemonConfig) {
  const config = providedConfig ?? await optionalConfig();
  if (!config) return { configured: false, status: currentStatus, projects: [] };
  let projects: ProjectSummary[];
  try {
    projects = (await companionApi<{ projects: ProjectSummary[] }>(config, "/companion/projects")).projects;
    knownProjects = projects;
  } catch (error) {
    projects = knownProjects.length ? knownProjects : localProjectFallback(config);
    notify({
      state: "error",
      message: `Could not load projects from ${config.serverUrl}: ${sanitizeText(error instanceof Error ? error.message : error)}. Local repository mappings are still saved.`,
    });
  }
  return {
    configured: true, serverUrl: config.serverUrl, userId: config.userId, status: currentStatus,
    projects, mappings: Object.fromEntries(Object.entries(config.projects).map(([id, binding]) => [id, { path: binding.path }])),
  };
}

function localProjectFallback(config: DaemonConfig): ProjectSummary[] {
  return Object.entries(config.projects).map(([id, binding]) => {
    const repositoryName = repositoryNameFromUrl(binding.remoteUrl) || basename(binding.path);
    return { id, name: repositoryName, repositoryName, repositoryUrl: binding.remoteUrl, branch: binding.branch ?? "main" };
  });
}

function repositoryNameFromUrl(remoteUrl: string) {
  return remoteUrl.replace(/\/$/, "").split(/[/:]/).at(-1)?.replace(/\.git$/i, "") ?? "";
}

function runGit(args: string[], cwd?: string): Promise<void> {
  return new Promise((accept, reject) => {
    const child = spawn("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let error = "";
    child.stderr.on("data", (chunk) => { error += String(chunk); notify({ state: "connecting" }); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? accept() : reject(new Error(sanitizeText(error.trim() || `git exited with ${code}`))));
  });
}

async function registerProtocolHandler() {
  if (app.isPackaged && process.platform === "darwin") {
    const bundlePath = resolve(dirname(process.execPath), "../../..");
    const launchServices = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
    await new Promise<void>((accept) => {
      const child = spawn(launchServices, ["-f", bundlePath], { stdio: "ignore" });
      child.once("error", () => accept());
      child.once("close", () => accept());
    });
  }
  if (app.isPackaged) app.setAsDefaultProtocolClient("relaycode");
  else if (process.platform !== "darwin") app.setAsDefaultProtocolClient("relaycode", process.execPath, [app.getAppPath()]);
}

async function mapExisting(project: ProjectSummary) {
  const selected = await dialog.showOpenDialog(window!, { title: `Choose your local ${project.name} repository`, properties: ["openDirectory"] });
  if (selected.canceled || !selected.filePaths[0]) return publicState();
  const config = await loadConfig();
  await addProjectBinding(config, project.id, selected.filePaths[0], project.repositoryUrl, project.branch);
  await saveConfig(config);
  await restartDaemon(config);
  return publicState(config);
}

async function cloneProject(project: ProjectSummary) {
  const remotePath = new URL(project.repositoryUrl.replace(/^git@github\.com:/, "https://github.com/")).pathname.replace(/\.git$/, "").split("/").filter(Boolean);
  const owner = remotePath.at(-2) ?? "github";
  const suggestedParent = join(homedir(), "Relaycode", "Projects", owner);
  await mkdir(suggestedParent, { recursive: true });
  const selected = await dialog.showOpenDialog(window!, {
    title: `Choose where to clone ${project.name}`,
    defaultPath: suggestedParent,
    buttonLabel: "Clone here",
    properties: ["openDirectory", "createDirectory"],
  });
  if (selected.canceled || !selected.filePaths[0]) return publicState();
  const target = join(selected.filePaths[0], project.repositoryName);
  if (existsSync(target)) throw new Error(`${target} already exists. Choose “Use existing folder” or another destination.`);
  await mkdir(dirname(target), { recursive: true });
  notify({ state: "connecting" });
  await runGit(["clone", "--origin", "origin", "--branch", project.branch, "--single-branch", project.repositoryUrl, target]);
  const config = await loadConfig();
  await addProjectBinding(config, project.id, target, project.repositoryUrl, project.branch);
  await saveConfig(config);
  await restartDaemon(config);
  return publicState(config);
}

async function acceptPairingUrl(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== "relaycode:") return;
  const server = url.searchParams.get("server");
  const code = url.searchParams.get("code");
  let serverUrl = server;
  let userId = url.searchParams.get("userId");
  let token = url.searchParams.get("token");
  if (server && code) {
    const response = await fetch(`${server.replace(/\/$/, "")}/api/companion/pair/claim`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }),
    });
    const result = await response.json().catch(() => ({})) as { userId?: string; daemonToken?: string; serverUrl?: string; githubToken?: string; error?: string };
    if (!response.ok || !result.userId || !result.daemonToken) throw new Error(result.error || "Pairing code is invalid or expired.");
    serverUrl = result.serverUrl ?? server;
    userId = result.userId;
    token = result.daemonToken;
    await installGitCredential(result.githubToken);
  }
  if (!serverUrl || !userId || !token) throw new Error("This pairing link is incomplete or expired.");
  const current = await optionalConfig();
  const config = DaemonConfigSchema.parse({ version: 1, serverUrl, userId, token, agent: current?.agent ?? { provider: "auto" }, projects: current?.projects ?? {} });
  await saveConfig(config);
  await restartDaemon(config);
  window?.webContents.send("companion:paired");
}

function createWindow() {
  const rendererFile = app.isPackaged
    ? join(process.resourcesPath, "renderer", "index.html")
    : join(app.getAppPath(), "src", "renderer", "index.html");
  window = new BrowserWindow({
    width: 920, height: 700, minWidth: 720, minHeight: 560, title: "Relaycode Companion",
    backgroundColor: "#f5f5f4", webPreferences: { preload: preloadFile, contextIsolation: true, nodeIntegration: false },
  });
  void window.loadFile(rendererFile).catch((error) => {
    const message = sanitizeText(error instanceof Error ? error.message : error);
    console.error(`Could not load Companion interface: ${message}`);
    void window?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<main style="font:14px system-ui;padding:32px"><h2>Relaycode Companion could not start</h2><p>${message}</p><p>Interface path: ${rendererFile}</p></main>`)}`);
  });
  window.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: "deny" }; });
}

ipcMain.handle("companion:state", () => publicState());
ipcMain.handle("companion:configure", (_event, input: SetupInput) => saveIdentity(input));
ipcMain.handle("companion:browser-login", async (_event, server: string) => {
  const serverUrl = new URL(server).origin;
  await shell.openExternal(`${serverUrl}/companion/connect?callback=${encodeURIComponent("relaycode://paired")}`);
  return { opened: true };
});
ipcMain.handle("companion:claim", async (_event, server: string, code: string) => {
  await acceptPairingUrl(`relaycode://paired?server=${encodeURIComponent(new URL(server).origin)}&code=${encodeURIComponent(code.trim())}`);
  return publicState();
});
ipcMain.handle("companion:map", (_event, project: ProjectSummary) => mapExisting(project));
ipcMain.handle("companion:clone", (_event, project: ProjectSummary) => cloneProject(project));
ipcMain.handle("companion:refresh", async () => {
  const config = await loadConfig();
  if (!running) await restartDaemon(config);
  return publicState(config);
});

const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on("second-instance", (_event, argv) => { window?.show(); window?.focus(); const link = argv.find((arg) => arg.startsWith("relaycode://")); if (link) void acceptPairingUrl(link); });
  app.on("open-url", (event, url) => { event.preventDefault(); void acceptPairingUrl(url); });
  void app.whenReady().then(async () => {
    // macOS must know the concrete bundle before it can replace an older generic
    // Electron URL handler. Windows and Linux preserve source-launch arguments.
    await registerProtocolHandler();
    createWindow();
    await installGitCredential().catch((error) => notify({ state: "error", message: sanitizeText(error instanceof Error ? error.message : error) }));
    const config = await optionalConfig();
    if (config) await restartDaemon(config);
    const link = process.argv.find((arg) => arg.startsWith("relaycode://"));
    if (link) await acceptPairingUrl(link).catch((error) => notify({ state: "error", message: sanitizeText(error instanceof Error ? error.message : error) }));
  });
}

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => { void running?.close(); });
