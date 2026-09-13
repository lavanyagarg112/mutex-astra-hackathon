import {
  Activity as ActivityIcon,
  AlertTriangle,
  ArrowDown,
  ArrowUpRight,
  Bot,
  Box,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CirclePause,
  CirclePlay,
  Clock3,
  Code2,
  Copy,
  Ellipsis,
  Eye,
  FileCode2,
  Folder,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  Github,
  History,
  Laptop2,
  Link2,
  LoaderCircle,
  Menu,
  MessageSquareReply,
  MonitorPlay,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Settings,
  ShieldCheck,
  Smartphone,
  Square,
  TerminalSquare,
  Trash2,
  UserRound,
  UserRoundPlus,
  UsersRound,
  Wifi,
  WifiOff,
  X,
  Zap,
} from "lucide-react";
import { forwardRef, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { Activity, FileEntry, GitHistoryResponse, ListDirectoryResponse, Message, PixelSkinId, Project, ReadFileResponse, StoredDiff, Task, TaskStatus, User } from "@relaycode/shared";
import { activeStatuses } from "@relaycode/shared";
import { API_URL, ApiError, api, beginGithubLogin, connectSocket, getActiveUserId, logout, setActiveUserId } from "./lib/api";
import type { Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@relaycode/shared";
import { PixelAvatar, PixelCrew } from "./PixelCrew";
import { PIXEL_SKINS } from "./pixelCharacters";

type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type Member = User & { online: boolean; present: boolean; daemonVersion?: string; syncedSha?: string; mapped?: boolean; synchronized?: boolean; localPath?: string; color: string };
type LastMessagePreview = { body: string; createdAt: string; authorName: string };
type ProjectItem = Project & { members: Member[]; onlineCount: number; memberCount?: number; lastMessage?: LastMessagePreview | null };
type ProcessInfo = { name: string; status: "running" | "stopped" | "starting" | "failed"; port?: number; url?: string };
type ProjectData = { project: ProjectItem; tasks: Task[]; messages: Message[]; activity: Activity[]; processes: ProcessInfo[] };
type AttachedRequestResult = { kind: "COMBINED_REQUEST" | "IN_FLIGHT_REFINEMENT"; taskId: string; messageId: string };
type ModalName = "project" | "createProject" | "initialize" | "user" | "share" | "rollback" | "cancel" | null;
type Toast = { id: number; message: string; tone?: "success" | "warning" };
type GithubRepository = { id: number | string; fullName: string; name: string; owner: string; cloneUrl: string; defaultBranch: string; private?: boolean; canWrite?: boolean; permissions?: { push?: boolean } };
type InferredCommands = Pick<Project, "installCommand" | "frontendCommand" | "backendCommand" | "testCommand"> & {
  detectedFrom: string[];
  inferenceMethod?: "deterministic" | "agent";
  diagnostics?: string[];
};
type PairingState = { status: "pairing" | "ready" | "error"; code?: string; message?: string };
type JoinState = { status: "joining" | "error" | "read-only"; message?: string };
type RepositoryFrontend = "REACT" | "NEXT_JS" | "VUE" | "SVELTE" | "NONE";
type RepositoryBackend = "EXPRESS" | "FASTIFY" | "NEST_JS" | "FASTAPI" | "DJANGO" | "NONE";
type RepositoryDatabase = "POSTGRESQL" | "MYSQL" | "SQLITE" | "MONGODB" | "NONE";

const alice: Member = { id: "alice", name: "Alice Chen", username: "alice", online: true, present: true, daemonVersion: "0.4.2", syncedSha: "4af71c2", color: "#343434" };
const bob: Member = { id: "bob", name: "Bob Rivera", username: "bob", online: true, present: true, daemonVersion: "0.4.2", syncedSha: "4af71c2", color: "#8e6b3d" };
const charlie: Member = { id: "charlie", name: "Charlie Park", username: "charlie", online: false, present: false, daemonVersion: "0.4.1", syncedSha: "91bc8e0", color: "#6d7079" };

const statusMeta: Record<TaskStatus, { label: string; tone: string; dot: string }> = {
  QUEUED: { label: "Queued", tone: "bg-zinc-100 text-zinc-600", dot: "bg-zinc-400" },
  WAITING_FOR_REQUESTER: { label: "Waiting for requester", tone: "bg-amber-50 text-amber-800", dot: "bg-amber-500" },
  SYNCING: { label: "Syncing", tone: "bg-blue-50 text-blue-700", dot: "bg-blue-500" },
  PLANNING: { label: "Planning", tone: "bg-blue-50 text-blue-700", dot: "bg-blue-500" },
  EDITING: { label: "Editing", tone: "bg-amber-50 text-amber-800", dot: "bg-amber-500" },
  VALIDATING: { label: "Validating", tone: "bg-violet-50 text-violet-700", dot: "bg-violet-500" },
  PUSHING: { label: "Pushing", tone: "bg-blue-50 text-blue-700", dot: "bg-blue-500" },
  SYNCING_TEAM: { label: "Syncing team", tone: "bg-blue-50 text-blue-700", dot: "bg-blue-500" },
  COMMITTED: { label: "Committed", tone: "bg-emerald-50 text-emerald-700", dot: "bg-emerald-500" },
  PAUSED: { label: "Paused", tone: "bg-zinc-200 text-zinc-700", dot: "bg-zinc-500" },
  FAILED: { label: "Failed", tone: "bg-red-50 text-red-700", dot: "bg-red-500" },
  CANCELLED: { label: "Cancelled", tone: "bg-red-50 text-red-700", dot: "bg-red-400" },
  REMOTE_DIVERGED: { label: "Remote changed · retrying", tone: "bg-orange-50 text-orange-700", dot: "bg-orange-500" },
  ROLLED_BACK: { label: "Rolled back", tone: "bg-zinc-100 text-zinc-600", dot: "bg-zinc-400" },
  DISCARDED_BY_ROLLBACK: { label: "Discarded by rollback", tone: "bg-zinc-100 text-zinc-500", dot: "bg-zinc-400" },
};

function cx(...classes: Array<string | false | null | undefined>) { return classes.filter(Boolean).join(" "); }
function shortSha(sha?: string | null) { return sha?.slice(0, 7) ?? "—"; }
function normalizeProject(raw: Project & Partial<ProjectItem>): ProjectItem {
  const members = Array.isArray(raw.members) ? raw.members : [];
  return { ...raw, members, onlineCount: raw.onlineCount ?? members.filter((member) => member.online).length };
}
function normalizeProjectPayload(raw: unknown): ProjectData | null {
  if (!raw || typeof raw !== "object") return null;
  const source = "data" in raw && raw.data && typeof raw.data === "object" ? raw.data as Record<string, unknown> : raw as Record<string, unknown>;
  if (!source.project || !Array.isArray(source.tasks)) return null;
  const serverMembers = Array.isArray(source.members) ? source.members.map((entry) => {
    const member = entry as User & { present?: boolean; daemon?: { online?: boolean; version?: string | null; mapped?: boolean; synchronized?: boolean; path?: string | null } };
    return { ...member, online: Boolean(member.daemon?.online), present: Boolean(member.present), daemonVersion: member.daemon?.version ?? undefined, mapped: Boolean(member.daemon?.mapped), synchronized: Boolean(member.daemon?.synchronized), localPath: member.daemon?.path ?? undefined, color: member.username === "alice" ? "#343434" : member.username === "bob" ? "#8e6b3d" : "#6d7079" } satisfies Member;
  }) : [];
  const project = normalizeProject({ ...(source.project as Project), members: serverMembers } as ProjectItem);
  const rawProcesses = Array.isArray(source.processes) ? source.processes : [];
  return {
    project,
    tasks: source.tasks as Task[],
    messages: (Array.isArray(source.messages) ? source.messages : []) as Message[],
    activity: (Array.isArray(source.activities) ? source.activities : Array.isArray(source.activity) ? source.activity : []) as Activity[],
    processes: rawProcesses.map((entry) => {
      const process = entry as { name?: string; status?: string; port?: number; url?: string };
      const status = process.status === "running" || process.status === "starting" || process.status === "failed" ? process.status : "stopped";
      return { name: process.name ?? "Local process", status, port: process.port, url: process.url };
    }),
  };
}
function when(value?: string | null) {
  if (!value) return "";
  const min = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000));
  return min < 1 ? "now" : min < 60 ? `${min}m` : min < 1440 ? `${Math.floor(min / 60)}h` : `${Math.floor(min / 1440)}d`;
}
function companionDeepLink(code: string) {
  const server = new URL(API_URL || window.location.origin, window.location.origin).origin;
  return `relaycode://paired?server=${encodeURIComponent(server)}&code=${encodeURIComponent(code)}`;
}

export default function App() {
  const [signedIn, setSignedIn] = useState(() => {
    const userId = new URLSearchParams(window.location.search).get("userId");
    if (userId) {
      setActiveUserId(userId);
      const url = new URL(window.location.href);
      url.searchParams.delete("userId");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    }
    return Boolean(getActiveUserId());
  });
  const [checkingSession, setCheckingSession] = useState(() => !Boolean(getActiveUserId()));
  useEffect(() => {
    if (signedIn) { setCheckingSession(false); return; }
    void api<{ user: User }>("/api/auth/session")
      .then(({ user }) => {
        setActiveUserId(user.id);
        const returnTo = window.localStorage.getItem("relaycode.authReturnTo");
        window.localStorage.removeItem("relaycode.authReturnTo");
        if (window.location.pathname === "/auth/callback" && returnTo?.startsWith("/")) window.history.replaceState({}, "", returnTo);
        setSignedIn(true);
      })
      .catch(() => undefined)
      .finally(() => setCheckingSession(false));
  }, [signedIn]);
  if (checkingSession) return <div className="grid min-h-screen place-items-center bg-[#f4f4f2]"><div className="flex items-center gap-2 text-[11px] text-zinc-500"><LoaderCircle size={15} className="animate-spin" /> Signing you in…</div></div>;
  if (!signedIn) return <LoginScreen />;
  return <Workspace />;
}

function Workspace() {
  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [projectId, setProjectId] = useState("");
  const [data, setData] = useState<ProjectData | null>(null);
  const [serverMode, setServerMode] = useState<"connecting" | "live" | "demo">("connecting");
  const [socket, setSocket] = useState<AppSocket | null>(null);
  const [modal, setModal] = useState<ModalName>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [composerReply, setComposerReply] = useState<Task | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [rightPanel, setRightPanel] = useState<"preview" | "activity" | "files" | "git">("preview");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.localStorage.getItem("relaycode.sidebarCollapsed") === "true");
  const [rightPanelWidth, setRightPanelWidth] = useState(() => {
    const stored = Number(window.localStorage.getItem("relaycode.rightPanelWidth"));
    return Number.isFinite(stored) && stored >= 320 ? stored : 420;
  });
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [currentUser, setCurrentUser] = useState<User>(() => getActiveUserId() === "bob" ? bob : getActiveUserId() === "charlie" ? charlie : alice);
  const [joinState, setJoinState] = useState<JoinState | null>(null);
  const [joinAttempt, setJoinAttempt] = useState(0);
  const [pairingState, setPairingState] = useState<PairingState | null>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const selectedProjectRef = useRef(projectId);
  selectedProjectRef.current = projectId;

  const constrainRightPanelWidth = (width: number) => {
    // Keep only a slim section of the conversation visible so the divider is
    // always easy to find and drag back, while letting the inspector use the
    // rest of the workspace for previews, files, and history.
    const workspaceWidth = workspaceRef.current?.clientWidth
      ?? window.innerWidth - (sidebarCollapsed ? 72 : window.innerWidth >= 1536 ? 270 : 248);
    const available = workspaceWidth - 120;
    return Math.max(320, Math.min(available, width));
  };

  useEffect(() => window.localStorage.setItem("relaycode.sidebarCollapsed", String(sidebarCollapsed)), [sidebarCollapsed]);
  useEffect(() => window.localStorage.setItem("relaycode.rightPanelWidth", String(rightPanelWidth)), [rightPanelWidth]);
  useEffect(() => {
    const fit = () => setRightPanelWidth((width) => constrainRightPanelWidth(width));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
    // Re-fit when the navigation rail changes the available workspace width.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidebarCollapsed]);

  const resizeRightPanel = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startingX = event.clientX;
    const startingWidth = rightPanelWidth;
    const move = (pointer: PointerEvent) => {
      setRightPanelWidth(constrainRightPanelWidth(startingWidth + startingX - pointer.clientX));
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
  };

  const toast = (messageText: string, tone: Toast["tone"] = "success") => {
    const id = Date.now();
    setToasts((items) => [...items, { id, message: messageText, tone }]);
    window.setTimeout(() => setToasts((items) => items.filter((item) => item.id !== id)), 3600);
  };

  const loadProject = async (nextId = projectId) => {
    if (!nextId) return;
    try {
      const payload = await api<unknown>(`/api/projects/${nextId}`);
      const next = normalizeProjectPayload(payload);
      if (next && selectedProjectRef.current === nextId) {
        setData(next);
        setServerMode("live");
      }
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 403) {
        setJoinState({ status: "error", message: reason.message });
        return;
      }
      setData(null);
      toast(reason instanceof Error ? reason.message : "Could not load this project.", "warning");
    }
  };

  useEffect(() => {
    let mounted = true;
    api<{ projects: Array<Project & Partial<ProjectItem>>; user?: User }>("/api/bootstrap")
      .then((payload) => {
        if (!mounted) return;
        const list = (payload.projects ?? []).map(normalizeProject);
        setProjects(list);
        if (list.length) setProjectId((current) => current && list.some((project) => project.id === current) ? current : list[0]!.id);
        else { setProjectId(""); setData(null); }
        if (payload.user) setCurrentUser(payload.user);
        setServerMode("live");
      })
      .catch(() => mounted && setServerMode("connecting"));

    // The socket connection is per-session, not per-project: it must survive
    // switching projects (the server joins it to every project room the user
    // belongs to). Recreating it on every project switch caused a visible
    // full-screen flicker as everything briefly went "connecting" again.
    const nextSocket = connectSocket();
    setSocket(nextSocket);
    const refresh = (payload: { projectId: string }) => { if (payload.projectId === selectedProjectRef.current) void loadProject(payload.projectId); };
    nextSocket.on("connect", () => setServerMode("live"));
    nextSocket.on("connect_error", () => setServerMode("connecting"));
    nextSocket.on("QUEUE_UPDATED", refresh);
    nextSocket.on("TASK_UPDATED", refresh);
    nextSocket.on("MESSAGE_CREATED", refresh);
    nextSocket.on("ACTIVITY_CREATED", refresh);
    nextSocket.on("DIFF_AVAILABLE", refresh);
    nextSocket.on("MEMBER_STATUS_CHANGED", refresh);
    nextSocket.on("MEMBER_PRESENCE_CHANGED", refresh);
    nextSocket.on("PROCESS_STATUS_CHANGED", refresh);
    nextSocket.on("MEMBER_APPEARANCE_CHANGED", refresh);
    nextSocket.on("ERROR", ({ message: error }) => toast(error, "warning"));
    return () => { mounted = false; nextSocket.disconnect(); };
    // Runs once for the lifetime of the session; per-project data loading is
    // handled by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (projectId) void loadProject(projectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    const match = window.location.pathname.match(/^\/join\/([^/]+)$/);
    if (!match) return;
    const invitedProjectId = decodeURIComponent(match[1]!);
    setJoinState({ status: "joining" });
    void api<{ project: Project; membership?: { role: string; repositoryWrite: boolean } }>(`/api/projects/${invitedProjectId}/join`, { method: "POST" })
      .then(({ project, membership }) => {
        const normalized = normalizeProject({ ...project, members: [], onlineCount: 0 });
        setProjects((items) => items.some((item) => item.id === project.id) ? items : [...items, normalized]);
        setProjectId(project.id);
        if (membership?.repositoryWrite === false) {
          setJoinState({ status: "read-only", message: `You joined ${project.name} with read-only repository access. You can follow the queue, but coding requests and Git operations require write access.` });
        } else {
          setJoinState(null);
          window.history.replaceState({}, "", "/");
          toast(`Joined ${project.name}. Repository access verified.`);
        }
      })
      .catch((reason: unknown) => {
        setJoinState({ status: "error", message: reason instanceof Error ? reason.message : "You could not join this project." });
      });
    // Invitation is handled once on initial load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joinAttempt]);

  useEffect(() => {
    if (window.location.pathname !== "/companion/connect") return;
    setPairingState({ status: "pairing" });
    void api<{ code: string; expiresAt: string }>("/api/companion/pair/start", { method: "POST" })
      .then(({ code }) => {
        setPairingState({ status: "ready", code });
        window.location.assign(companionDeepLink(code));
      })
      .catch((reason: unknown) => setPairingState({ status: "error", message: reason instanceof Error ? reason.message : "Could not pair this companion." }));
  }, []);

  // A queued request absorbed into an amendable active task remains in the
  // database for audit history, but is rendered once as a reply on that task.
  const tasks = (data?.tasks ?? []).filter((task) => !(task.status === "CANCELLED" && task.shortStatus?.startsWith("Combined into Request #")));
  const active = useMemo(() => tasks.find((task) => activeStatuses.includes(task.status)) ?? null, [tasks]);
  const pending = useMemo(() => tasks
    .filter((task) => task.status === "QUEUED" || task.status === "WAITING_FOR_REQUESTER" || task.status === "REMOTE_DIVERGED")
    .sort((a, b) => b.queuePriority - a.queuePriority || a.queueSequence - b.queueSequence), [tasks]);
  const queuePositions = useMemo(() => new Map(pending.map((task, index) => [task.id, index + 1])), [pending]);
  const conversation = useMemo(() => {
    const taskMessageIds = new Set(tasks.flatMap((task) => [task.rootMessageId, ...(task.messages ?? []).map((message) => message.id)]));
    return [
      ...tasks.map((task) => ({ kind: "task" as const, createdAt: task.createdAt, task })),
      ...(data?.messages ?? [])
        .filter((message) => !taskMessageIds.has(message.id))
        .map((message) => ({ kind: "message" as const, createdAt: message.createdAt, message })),
    ].sort((a, b) => {
      const byCreatedAt = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      if (byCreatedAt) return byCreatedAt;
      if (a.kind === "task" && b.kind === "task") return a.task.number - b.task.number;
      return a.kind === "message" ? 1 : -1;
    });
  }, [data?.messages, tasks]);

  const chooseProject = (id: string) => {
    if (id !== projectId) setData(null);
    setProjectId(id);
    setMobileNav(false);
    setComposerReply(null);
  };

  if (!projectId) {
    return <div className="flex min-h-screen bg-white text-ink">
      <ProjectSidebar projects={projects} user={currentUser} selectedId="" open={mobileNav} collapsed={sidebarCollapsed} onToggleCollapsed={() => setSidebarCollapsed((value) => !value)} onClose={() => setMobileNav(false)} onSelect={chooseProject} onCreateProject={() => setModal("createProject")} onUserSettings={() => setModal("user")} />
      <main className="grid min-w-0 flex-1 place-items-center px-6">
        <div className="max-w-md text-center">
          <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-zinc-950 text-white"><FolderGit2 size={20} /></div>
          <h1 className="mt-5 text-2xl font-semibold tracking-tight">Create your first project</h1>
          <p className="mt-2 text-sm leading-6 text-zinc-500">Choose a GitHub repository you can write to. Mutex will create the shared request queue, then your Companion can clone it or connect an existing folder.</p>
          <button onClick={() => setModal("createProject")} className="mt-6 inline-flex items-center gap-2 rounded-xl bg-zinc-950 px-4 py-3 text-xs font-medium text-white"><Plus size={14} /> Create project</button>
        </div>
      </main>
      {modal === "createProject" && <CreateProjectModal user={currentUser} onClose={() => setModal(null)} onCreated={(project) => { const normalized = normalizeProject({ ...project, members: [], onlineCount: 0 }); setProjects([normalized]); setProjectId(project.id); setModal(null); }} />}
      {modal === "user" && <UserSettingsModal projects={projects} user={currentUser} socket={socket} onClose={() => setModal(null)} onUpdated={setCurrentUser} />}
    </div>;
  }

  if (!data || data.project.id !== projectId) {
    return <div className="grid min-h-screen place-items-center bg-white"><div className="flex items-center gap-2 text-[11px] text-zinc-500"><LoaderCircle size={15} className="animate-spin" /> Loading project…</div></div>;
  }

  const emitControl = (kind: "pause" | "resume" | "cancel", task: Task) => {
    const event = kind === "pause" ? "PAUSE_ACTIVE_TASK" : kind === "resume" ? "RESUME_ACTIVE_TASK" : "CANCEL_ACTIVE_TASK";
    socket?.emit(event, { projectId: data.project.id, taskId: task.id });
    const queued = ["QUEUED", "WAITING_FOR_REQUESTER", "REMOTE_DIVERGED"].includes(task.status);
    toast(kind === "pause" ? "Task paused. The project lock is still held." : kind === "resume" ? "Task resumed on the same companion." : queued ? "Request removed from the execution queue." : "Task cancelled and local tracked changes reset.", kind === "cancel" ? "warning" : "success");
  };

  return (
    <div className="min-h-screen bg-white text-ink lg:h-screen lg:overflow-hidden">
      <div className="flex min-h-screen w-full overflow-hidden bg-white lg:h-screen lg:min-h-0">
        <ProjectSidebar projects={projects} user={currentUser} companion={data.project.members.find((member) => member.id === currentUser.id)} selectedId={projectId} open={mobileNav} collapsed={sidebarCollapsed} onToggleCollapsed={() => setSidebarCollapsed((value) => !value)} onClose={() => setMobileNav(false)} onSelect={chooseProject} onCreateProject={() => setModal("createProject")} onUserSettings={() => setModal("user")} />

        <main className="flex min-w-0 flex-1 flex-col bg-white">
          <ProjectHeader
            project={data.project} mode={serverMode} onMenu={() => setMobileNav(true)}
            onProjectSettings={() => setModal("project")} onShare={() => setModal("share")}
          />

          <div ref={workspaceRef} className="workspace-columns grid min-h-0 flex-1 grid-cols-1" style={{ "--right-panel-width": `${rightPanelWidth}px` } as CSSProperties}>
            <section className="relative flex min-h-[700px] min-w-0 flex-col border-r border-zinc-200/80 lg:min-h-0">
              <QueueHeader pendingCount={pending.length} />
              <div className="fine-scrollbar flex-1 overflow-y-auto px-4 pb-44 pt-2 sm:px-6 lg:px-8">
                <div className="mx-auto max-w-3xl space-y-3">
                  {conversation.length ? conversation.map((item) => {
                    if (item.kind === "message") return <TeamMessage key={`message:${item.message.id}`} message={item.message} currentUser={currentUser} />;
                    const task = item.task;
                    const taskIsActive = active?.id === task.id;
                    return <TaskCard key={`task:${task.id}`} task={task} queuePosition={queuePositions.get(task.id)} onRefine={(item) => { setComposerReply(item); composerRef.current?.focus(); }} onPause={() => taskIsActive && emitControl("pause", task)} onResume={() => taskIsActive && emitControl("resume", task)} onCancel={() => { setSelectedTask(task); setModal("cancel"); }} onRollback={(item) => { setSelectedTask(item); setModal("rollback"); }} />;
                  }) : <EmptyQueue />}
                </div>
              </div>
              <Composer ref={composerRef} project={data.project} user={currentUser} replyTask={composerReply} serverMode={serverMode} socket={socket} onCancelReply={() => setComposerReply(null)} onCreated={(task) => { setData((current) => current ? ({ ...current, tasks: current.tasks.some((item) => item.id === task.id) ? current.tasks.map((item) => item.id === task.id ? task : item) : [...current.tasks, task] }) : current); toast(task.type === "REFINEMENT" ? "Refinement added at high priority." : "Request added to the execution queue."); }} onAttached={(result) => { toast(result.kind === "COMBINED_REQUEST" ? "Request combined into an existing task." : "Refinement merged into the active request."); void loadProject(data.project.id); }} onMessageCreated={(message) => { setData((current) => current ? ({ ...current, messages: current.messages.some((item) => item.id === message.id) ? current.messages : [...current.messages, message] }) : current); }} />
            </section>

            <aside className="relative hidden min-h-0 bg-[#fafaf9] xl:flex xl:flex-col">
              <div role="separator" aria-label="Resize preview panel" aria-orientation="vertical" tabIndex={0} onPointerDown={resizeRightPanel} onKeyDown={(event) => { if (event.key === "ArrowLeft") setRightPanelWidth((width) => constrainRightPanelWidth(width + 24)); if (event.key === "ArrowRight") setRightPanelWidth((width) => constrainRightPanelWidth(width - 24)); }} className="group absolute inset-y-0 -left-1.5 z-20 flex w-3 cursor-col-resize touch-none items-center justify-center outline-none"><span className="h-10 w-0.5 rounded-full bg-zinc-300 opacity-0 transition group-hover:opacity-100 group-focus:opacity-100 group-active:bg-zinc-500 group-active:opacity-100" /></div>
              <div className="flex border-b border-zinc-200 bg-white px-4 pt-3">
                <PanelTab active={rightPanel === "preview"} icon={<MonitorPlay size={14} />} onClick={() => setRightPanel("preview")}>Local preview</PanelTab>
                <PanelTab active={rightPanel === "activity"} icon={<TerminalSquare size={14} />} onClick={() => setRightPanel("activity")}>Activity</PanelTab>
                <PanelTab active={rightPanel === "files"} icon={<FileCode2 size={14} />} onClick={() => setRightPanel("files")}>Files</PanelTab>
                <PanelTab active={rightPanel === "git"} icon={<History size={14} />} onClick={() => setRightPanel("git")}>History</PanelTab>
              </div>
              {rightPanel === "preview" ? <PreviewPanel key={data.project.id} project={data.project} processes={data.processes} mode={serverMode} />
                : rightPanel === "activity" ? <ActivityPanel activity={data.activity} />
                : rightPanel === "files" ? <FilesPanel key={data.project.id} project={data.project} />
                : <GitHistoryPanel key={data.project.id} project={data.project} />}
            </aside>
          </div>
        </main>
      </div>

      <div className="fixed bottom-24 right-4 z-[70] flex flex-col gap-2">
        {toasts.map((item) => <div key={item.id} className={cx("enter-up flex max-w-sm items-center gap-2 rounded-xl border bg-zinc-950 px-4 py-3 text-sm text-white shadow-float", item.tone === "warning" ? "border-orange-500/40" : "border-white/10")}>
          {item.tone === "warning" ? <AlertTriangle size={15} className="text-orange-300" /> : <CheckCircle2 size={15} className="text-emerald-300" />}{item.message}
        </div>)}
      </div>

      <PixelCrew members={data.project.members} activeTask={active} projectId={projectId} socket={socket} currentUserId={currentUser.id} />

      {modal === "project" && <ProjectSettingsModal project={data.project} onClose={() => setModal(null)} onInitialize={() => setModal("initialize")} onSave={(project) => { setData((current) => current ? ({ ...current, project: { ...current.project, ...project } }) : current); setModal(null); toast("Project settings saved."); }} />}
      {modal === "createProject" && <CreateProjectModal user={currentUser} onClose={() => setModal(null)} onCreated={(project) => { const normalized = normalizeProject({ ...project, members: [], onlineCount: 0 }); setProjects((current) => [...current, normalized]); setProjectId(project.id); setModal(null); toast("Project created. Open the companion to clone or connect the repository."); }} />}
      {modal === "initialize" && <InitializeRepositoryModal project={data.project} onClose={() => setModal(null)} onStarted={() => { setModal(null); toast("Repository initialization queued. It will run on your companion without requiring an existing validation command."); }} />}
      {modal === "user" && <UserSettingsModal projects={projects} user={currentUser} socket={socket} onClose={() => setModal(null)} onUpdated={setCurrentUser} />}
      {modal === "share" && <ShareModal project={data.project} onClose={() => setModal(null)} toast={toast} />}
      {modal === "cancel" && selectedTask && <CancelModal task={selectedTask} onClose={() => setModal(null)} onConfirm={() => { emitControl("cancel", selectedTask); setModal(null); }} />}
      {modal === "rollback" && selectedTask && <RollbackModal task={selectedTask} allTasks={data.tasks} socket={socket} serverMode={serverMode} onClose={() => setModal(null)} onConfirm={(discarded) => {
        setModal(null); toast(`Remote history reset. ${discarded.length} task${discarded.length === 1 ? "" : "s"} removed from ${data.project.branch}.`, "warning");
      }} />}
      {joinState && <JoinProjectStatus state={joinState} onRetry={() => setJoinAttempt((attempt) => attempt + 1)} onClose={() => { setJoinState(null); window.history.replaceState({}, "", "/"); }} />}
      {pairingState && <CompanionConnectStatus state={pairingState} onClose={() => { setPairingState(null); window.history.replaceState({}, "", "/"); }} />}
    </div>
  );
}

function LoginScreen() {
  const oauthError = new URLSearchParams(window.location.search).get("error");
  return <div className="grid min-h-screen place-items-center bg-[#f4f4f2] p-5">
    <div className="enter-up w-full max-w-[420px] overflow-hidden rounded-[24px] border border-zinc-200 bg-white shadow-float">
      <div className="border-b border-zinc-100 px-7 pb-7 pt-8">
        <img src="/brand/mutex-mark-navy.png" alt="Mutex" className="size-11 rounded-[14px] object-cover" />
        <h1 className="mt-6 text-[28px] font-semibold tracking-[-0.045em]">Welcome to Mutex</h1>
        <p className="mt-2 text-[12px] leading-5 text-zinc-500">Sign in to collaborate on repositories your GitHub account can access.</p>
      </div>
      <div className="px-7 py-7">
        {oauthError && <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-[10px] leading-4 text-red-700">{oauthError}</div>}
        <button onClick={beginGithubLogin} className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-zinc-950 text-[11px] font-medium text-white transition hover:bg-zinc-800"><Github size={15} /> Continue with GitHub</button>
      </div>
    </div>
  </div>;
}

function ProjectSidebar({ projects, user, companion, selectedId, open, collapsed, onToggleCollapsed, onClose, onSelect, onCreateProject, onUserSettings }: { projects: ProjectItem[]; user: User; companion?: Member; selectedId: string; open: boolean; collapsed: boolean; onToggleCollapsed: () => void; onClose: () => void; onSelect: (id: string) => void; onCreateProject: () => void; onUserSettings: () => void }) {
  return <>
    {open && <button aria-label="Close project navigation" className="fixed inset-0 z-40 bg-black/20 backdrop-blur-[1px] lg:hidden" onClick={onClose} />}
    <aside className={cx("fixed inset-y-0 left-0 z-50 flex w-[276px] flex-col border-r border-zinc-200 bg-[#f7f7f5] p-3 shadow-float transition-[transform,width] duration-300 lg:static lg:z-auto lg:translate-x-0 lg:shadow-none", collapsed ? "lg:w-[72px]" : "lg:w-[248px] 2xl:w-[270px]", open ? "translate-x-0" : "-translate-x-[110%]") }>
      <div className="relative flex items-center justify-between px-2 py-2.5">
        <div className="flex items-center gap-2.5">
          <button
            aria-label="Expand project navigation"
            title="Expand sidebar"
            onClick={onToggleCollapsed}
            className={cx("hidden size-8 shrink-0 place-items-center overflow-hidden rounded-[10px] transition hover:opacity-80", collapsed && "lg:grid")}
          >
            <img src="/brand/mutex-mark-navy.png" alt="Mutex" className="size-full object-cover" />
          </button>
          <img src="/brand/mutex-wordmark.png" alt="Mutex" className={cx("h-5 w-auto shrink-0 [mix-blend-mode:multiply]", collapsed && "lg:hidden")} />
        </div>
        <button aria-label="Close navigation" className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-200 lg:hidden" onClick={onClose}><X size={17} /></button>
        {!collapsed && <button aria-label="Collapse project navigation" title="Collapse sidebar" className="hidden rounded-lg p-1.5 text-zinc-400 transition hover:bg-zinc-200 hover:text-zinc-700 lg:block" onClick={onToggleCollapsed}><ChevronRight size={14} className="rotate-180" /></button>}
      </div>

      <div className={cx("mt-7 flex items-center justify-between px-2", collapsed && "lg:justify-center lg:px-0")}>
        <span className={cx("text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400", collapsed && "lg:hidden")}>Projects</span>
        <button aria-label="Create project" onClick={onCreateProject} className="rounded-md p-1 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700"><Plus size={14} /></button>
      </div>
      <nav className="mt-2 flex flex-col gap-1">
        {projects.map((project) => <button key={project.id} title={collapsed ? project.name : undefined} onClick={() => onSelect(project.id)} className={cx("group relative flex items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition", collapsed && "lg:justify-center lg:px-0", selectedId === project.id ? cx("text-zinc-950", !collapsed && "bg-white shadow-sm ring-1 ring-zinc-200") : "text-zinc-600 hover:bg-zinc-200/60")}>
          <div className={cx("grid size-8 shrink-0 place-items-center rounded-lg border text-[11px] font-semibold", selectedId === project.id ? "border-zinc-800 bg-zinc-900 text-white" : "border-zinc-200 bg-white text-zinc-500")}>{project.name.split(" ").map((word) => word[0]).join("").slice(0, 2)}</div>
          <div className={cx("min-w-0 flex-1", collapsed && "lg:hidden")}>
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[12px] font-medium">{project.name}</span>
              {project.lastMessage && <span className="shrink-0 text-[9px] text-zinc-400">{when(project.lastMessage.createdAt)}</span>}
            </div>
            {project.lastMessage && <div className="mt-0.5 truncate text-[10px] text-zinc-400">{project.lastMessage.authorName}: {project.lastMessage.body}</div>}
          </div>
          {project.onlineCount > 0 && <span className={cx("flex items-center gap-1 text-[9px] text-zinc-400", collapsed && "lg:absolute lg:bottom-1.5 lg:right-1.5")}><span className="size-1.5 rounded-full bg-emerald-500" /><span className={cx(collapsed && "lg:hidden")}>{project.onlineCount}</span></span>}
        </button>)}
      </nav>

      <div className="mt-auto space-y-2 pt-6">
        <div title={collapsed ? `Local companion: ${companion?.online ? "online" : "offline"}` : undefined} className={cx("relative rounded-xl border border-zinc-200 bg-white p-3", collapsed && "lg:grid lg:h-10 lg:place-items-center lg:p-0")}>
          <div className="flex items-center gap-2 text-[11px] font-medium"><Laptop2 size={14} /><span className={cx(collapsed && "lg:hidden")}>Local companion</span><span className={cx("ml-auto size-2 rounded-full", collapsed && "lg:absolute lg:right-1.5 lg:top-1.5 lg:ml-0", companion?.online ? "bg-emerald-500" : "bg-zinc-300")} /></div>
          <div className={cx("mt-1.5 text-[10px] text-zinc-400", collapsed && "lg:hidden")}>{companion?.online ? `Online · v${companion.daemonVersion ?? "unknown"}${companion.synchronized ? " · synced" : ""}` : "Offline · start the local daemon"}</div>
        </div>
        <button title={collapsed ? user.name : undefined} onClick={onUserSettings} className={cx("flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left hover:bg-zinc-200/60", collapsed && "lg:justify-center lg:px-0")}>
          <Avatar user={user} size="sm" online />
          <div className={cx("min-w-0 flex-1", collapsed && "lg:hidden")}><div className="text-[12px] font-medium">{user.name}</div><div className="text-[10px] text-zinc-400">Personal settings</div></div>
          <MoreHorizontal size={15} className={cx("text-zinc-400", collapsed && "lg:hidden")} />
        </button>
      </div>
    </aside>
  </>;
}

function ProjectHeader({ project, mode, onMenu, onProjectSettings, onShare }: { project: ProjectItem; mode: "connecting" | "live" | "demo"; onMenu: () => void; onProjectSettings: () => void; onShare: () => void }) {
  return <header className="flex h-[74px] shrink-0 items-center justify-between border-b border-zinc-200 px-4 sm:px-6">
    <div className="flex min-w-0 items-center gap-3">
      <button aria-label="Open projects" className="rounded-lg p-2 text-zinc-600 hover:bg-zinc-100 lg:hidden" onClick={onMenu}><Menu size={19} /></button>
      <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-zinc-950 text-[11px] font-semibold text-white">{project.name.split(" ").map((word) => word[0]).join("").slice(0, 2).toUpperCase()}</div>
      <div className="min-w-0">
        <h1 className="truncate text-[15px] font-semibold tracking-[-0.02em]">{project.name}</h1>
        <div className="mt-1 flex items-center gap-1.5 text-[12px] text-zinc-400"><Github size={14} /><span className="truncate">{project.repositoryOwner}/{project.repositoryName}</span><span>·</span><GitBranch size={13} />{project.branch}</div>
      </div>
    </div>
    <div className="flex items-center gap-2">
      <div title={mode === "live" ? "Connected to backend" : "Interactive demo data"} className={cx("mr-1 hidden items-center gap-1.5 rounded-full px-2.5 py-1 text-[9px] font-semibold uppercase tracking-wider sm:flex", mode === "live" ? "bg-emerald-50 text-emerald-700" : mode === "connecting" ? "bg-zinc-100 text-zinc-500" : "bg-amber-50 text-amber-700")}>
        <span className={cx("size-1.5 rounded-full", mode === "live" ? "bg-emerald-500" : mode === "connecting" ? "bg-zinc-400 pulse-soft" : "bg-amber-500")} />{mode === "live" ? "Live" : mode === "connecting" ? "Connecting" : "Demo"}
      </div>
      <div className="hidden items-center -space-x-2 sm:flex">
        {project.members.slice(0, 3).map((member) => <div key={member.id} title={`${member.name} · ${member.online ? "online" : "offline"}`}><Avatar user={member} size="sm" online={member.online} ring /></div>)}
      </div>
      <button aria-label="Project settings" onClick={onProjectSettings} className="grid size-9 place-items-center rounded-xl border border-zinc-200 text-zinc-600 transition hover:bg-zinc-50"><Settings size={16} /></button>
      <button onClick={onShare} className="flex h-9 items-center gap-2 rounded-xl bg-zinc-950 px-3 text-[11px] font-medium text-white transition hover:bg-zinc-800"><UserRoundPlus size={14} /><span className="hidden sm:inline">Invite</span></button>
    </div>
  </header>;
}

function QueueHeader({ pendingCount }: { pendingCount: number }) {
  return <div className="flex shrink-0 items-center justify-between px-4 pb-3 pt-5 sm:px-6 lg:px-8">
    <h2 className="text-[19px] font-semibold tracking-[-0.035em]">Project conversation</h2>
    <div className="hidden items-center gap-1.5 text-[12px] font-medium text-zinc-500 sm:flex"><Clock3 size={14} />{pendingCount} waiting</div>
  </div>;
}

function QueueGroup({ title, count, children, emphasis, subdued }: { title: string; count: number; children: ReactNode; emphasis?: boolean; subdued?: boolean }) {
  return <section className={cx("mb-8", subdued && "opacity-[.94]")}>
    <div className="mb-2 flex items-center gap-2 px-1"><span className={cx("text-[10px] font-semibold uppercase tracking-[0.13em]", emphasis ? "text-amber-700" : "text-zinc-400")}>{title}</span><span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[9px] font-medium text-zinc-400">{count}</span><div className="h-px flex-1 bg-zinc-100" /></div>
    <div className="space-y-2.5">{children}</div>
  </section>;
}

function TaskCard({ task, queuePosition, onRefine, onPause, onResume, onCancel, onRollback }: { task: Task; queuePosition?: number; onRefine: (task: Task) => void; onPause: () => void; onResume: () => void; onCancel: () => void; onRollback: (task: Task) => void }) {
  const [diffOpen, setDiffOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const person = task.requestedBy ?? (task.requestedByUserId === "alice" ? alice : task.requestedByUserId === "bob" ? bob : charlie);
  const executor = task.executor ?? person;
  const meta = statusMeta[task.status] ?? statusMeta.QUEUED;
  const isActive = activeStatuses.includes(task.status);
  const isCommitted = task.status === "COMMITTED";
  const isPending = ["QUEUED", "WAITING_FOR_REQUESTER", "REMOTE_DIVERGED"].includes(task.status);
  const isDiscarded = task.status === "DISCARDED_BY_ROLLBACK" || task.status === "ROLLED_BACK";
  return <article id={`task-${task.number}`} className={cx("group relative rounded-[18px] border transition-all duration-300", isActive ? "active-sheen border-amber-300/80 bg-amber-50/25 shadow-[0_10px_30px_rgba(161,112,33,.08)]" : "border-transparent bg-transparent hover:bg-zinc-50/80", isDiscarded && "bg-zinc-50 opacity-70")}>
    {isActive && <div className="absolute left-5 right-5 top-0 h-[2px] bg-gradient-to-r from-transparent via-amber-500 to-transparent" />}
    <div className="relative p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <Avatar user={person} size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[12px] font-semibold">{person.name}</span>
            <span className="text-[10px] text-zinc-400">{when(task.createdAt)}</span>
            {task.type === "REFINEMENT" && <span className="flex items-center gap-1 rounded-full bg-amber-50 px-2 py-1 text-[9px] font-semibold uppercase tracking-wider text-amber-800"><ArrowUpRight size={10} /> Priority refinement</span>}
          </div>
          {task.parentTask && <button onClick={() => document.getElementById(`task-${task.parentTask?.number}`)?.scrollIntoView({ behavior: "smooth", block: "center" })} className="mt-2 flex max-w-full items-center gap-1.5 rounded-lg bg-zinc-50 px-2 py-1.5 text-left text-[10px] text-zinc-500 hover:bg-zinc-100"><MessageSquareReply size={11} /><span className="font-medium">Refinement of Request #{task.parentTask.number}</span><span className="truncate text-zinc-400">· {task.parentTask.rootMessage.body}</span></button>}
          <p className="mt-2.5 text-[13px] leading-5 text-zinc-800 sm:text-[14px]">{task.rootMessage?.body ?? "Untitled coding request"}</p>
        </div>
        <div className="relative shrink-0">
          <button aria-label="Task menu" onClick={() => setMenuOpen(!menuOpen)} className="rounded-lg p-1.5 text-zinc-400 opacity-70 hover:bg-zinc-100 hover:text-zinc-700 group-hover:opacity-100"><Ellipsis size={16} /></button>
          {menuOpen && <div className="absolute right-0 top-8 z-20 w-40 rounded-xl border border-zinc-200 bg-white p-1.5 text-[11px] shadow-float">
            <button onClick={() => { onRefine(task); setMenuOpen(false); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 hover:bg-zinc-50"><MessageSquareReply size={13} /> Refine request</button>
            {isPending && <button onClick={() => { onCancel(); setMenuOpen(false); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-red-600 hover:bg-red-50"><Trash2 size={13} /> Delete request</button>}
            {isCommitted && <button onClick={() => { onRollback(task); setMenuOpen(false); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-red-600 hover:bg-red-50"><RotateCcw size={13} /> Roll back here</button>}
          </div>}
        </div>
      </div>

      {!!task.messages?.length && <div className="ml-[46px] mt-4 border-l border-zinc-200 pl-4">
        {task.messages.map((reply) => <div key={reply.id} className="flex gap-2.5 py-1"><Avatar user={reply.author ?? bob} size="xs" /><div><div className="flex items-center gap-2 text-[10px]"><span className="font-semibold">{reply.author?.name ?? "Teammate"}</span><span className="text-zinc-400">{reply.taskRole === "COMBINED_REQUEST" ? "Combined into this task" : "In-flight refinement"}</span></div><p className="mt-1 text-[12px] leading-5 text-zinc-600">{reply.body}</p></div></div>)}
      </div>}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-3">
        <span className={cx("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-[9px] font-semibold uppercase tracking-[.08em]", meta.tone)}><span className={cx("size-1.5 rounded-full", meta.dot, isActive && task.status !== "PAUSED" && "pulse-soft")} />{meta.label}</span>
        <span className="text-[10px] font-medium text-zinc-400">Request #{task.number}</span>
        {queuePosition && <span className="text-[10px] text-zinc-400">· runs {queuePosition === 1 ? "next" : `#${queuePosition}`}</span>}
        {task.amendable && <span className="flex items-center gap-1 rounded-full border border-emerald-200 px-2 py-1 text-[9px] font-medium text-emerald-700"><Zap size={9} /> Amendable now</span>}
        <div className="ml-auto flex items-center gap-1.5">
          {isActive && task.status !== "PAUSED" && <button onClick={onPause} className="flex items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-[10px] font-medium hover:bg-zinc-50"><Pause size={11} /> Pause</button>}
          {task.status === "PAUSED" && <button onClick={onResume} className="flex items-center gap-1.5 rounded-lg bg-zinc-900 px-2.5 py-1.5 text-[10px] font-medium text-white"><Play size={11} /> Resume</button>}
          {isActive && <button onClick={onCancel} className="rounded-lg border border-zinc-200 p-1.5 text-zinc-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600" aria-label="Cancel active task"><Square size={11} fill="currentColor" /></button>}
          {isPending && <button onClick={onCancel} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[10px] font-medium text-zinc-400 hover:bg-red-50 hover:text-red-600"><Trash2 size={11} /> Delete</button>}
        </div>
      </div>

      {isActive && <div className="mt-3 rounded-xl bg-[#faf8f2] px-3 py-2.5">
        <div className="flex items-center gap-2 text-[10px]"><LoaderCircle size={12} className={task.status === "PAUSED" ? "" : "animate-spin text-amber-700"} /><span className="font-medium text-zinc-700">{task.shortStatus}</span><span className="ml-auto text-zinc-400">on {executor?.name?.split(" ")[0] ?? "local machine"}’s companion</span></div>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-amber-100"><div className={cx("h-full rounded-full bg-amber-500 transition-all duration-700", task.status === "PLANNING" ? "w-1/4" : task.status === "EDITING" ? "w-[58%]" : task.status === "VALIDATING" ? "w-3/4" : task.status === "PUSHING" ? "w-[88%]" : task.status === "SYNCING_TEAM" ? "w-[96%]" : "w-2/5")} /></div>
      </div>}

      {task.status === "WAITING_FOR_REQUESTER" && <div className="mt-3 flex items-center gap-2 rounded-xl border border-amber-200/70 bg-amber-50/60 px-3 py-2.5 text-[10px] text-amber-900"><WifiOff size={13} /><span><strong>{task.shortStatus ?? `${person.name.split(" ")[0]}’s companion is not ready`}.</strong> This task keeps its queue priority and starts automatically when the companion is ready.</span></div>}

      {task.status === "FAILED" && task.failureReason && <div className="mt-3 flex items-start gap-2 rounded-xl border border-red-200/70 bg-red-50/60 px-3 py-2.5 text-[10px] leading-4 text-red-900"><AlertTriangle size={13} className="mt-0.5 shrink-0" /><span><strong>Task stopped safely.</strong> {task.failureReason}</span></div>}

      {isCommitted && <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-emerald-50/50 px-3 py-2.5 text-[10px]">
        <span className="flex items-center gap-1.5 text-emerald-800"><CheckCircle2 size={12} /><strong>Accepted automatically</strong></span>
        <span className="text-zinc-500">Executed by <strong className="text-zinc-700">{executor?.name ?? person.name}</strong></span>
        <span className="flex items-center gap-1 font-mono text-zinc-600"><GitCommitHorizontal size={12} />{shortSha(task.commitSha)}</span>
      </div>}

      {isCommitted && <div className="mt-3 flex items-center gap-2">
        <button onClick={() => setDiffOpen(!diffOpen)} className="flex items-center gap-1.5 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-[10px] font-medium hover:bg-zinc-50">{diffOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}<Code2 size={12} /> View diff {task.diff && <span className="text-emerald-600">+{task.diff.files.reduce((sum, file) => sum + file.additions, 0)}</span>}</button>
        <button onClick={() => onRefine(task)} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[10px] font-medium text-zinc-600 hover:bg-zinc-50"><MessageSquareReply size={12} /> Refine</button>
        <button onClick={() => onRollback(task)} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[10px] font-medium text-zinc-500 hover:bg-red-50 hover:text-red-600"><RotateCcw size={12} /> Rollback</button>
      </div>}

      {diffOpen && task.diff && <DiffViewer diff={task.diff} />}
    </div>
  </article>;
}

function TeamMessage({ message, currentUser }: { message: Message; currentUser: User }) {
  const person = message.author ?? (message.authorId === currentUser.id ? currentUser : { id: message.authorId, name: "Teammate", username: "teammate" });
  const mine = message.authorId === currentUser.id;
  return <div className={cx("flex items-start gap-3 px-4 py-2", mine && "flex-row-reverse")}>
    <Avatar user={person} size="sm" />
    <div className={cx("max-w-[78%]", mine && "text-right")}>
      <div className={cx("mb-1 flex items-center gap-2 text-[10px]", mine && "justify-end")}><span className="font-semibold text-zinc-700">{person.name}</span><span className="text-zinc-400">{when(message.createdAt)}</span></div>
      <div className={cx("inline-block rounded-2xl px-3.5 py-2.5 text-left text-[13px] leading-5", mine ? "rounded-tr-md bg-zinc-900 text-white" : "rounded-tl-md bg-zinc-100 text-zinc-800")}>
        {message.body}
      </div>
    </div>
  </div>;
}

function DiffViewer({ diff }: { diff: StoredDiff }) {
  const [view, setView] = useState<"files" | "patch">("files");
  return <div className="mt-3 overflow-hidden rounded-xl border border-zinc-200 bg-[#fbfbfa]">
    <div className="flex items-center border-b border-zinc-200 bg-white px-3 py-2">
      <div className="flex gap-1 rounded-lg bg-zinc-100 p-0.5"><button onClick={() => setView("files")} className={cx("rounded-md px-2 py-1 text-[9px] font-medium", view === "files" && "bg-white shadow-sm")}>Files</button><button onClick={() => setView("patch")} className={cx("rounded-md px-2 py-1 text-[9px] font-medium", view === "patch" && "bg-white shadow-sm")}>Unified diff</button></div>
      <span className="ml-auto font-mono text-[9px] text-zinc-400">{shortSha(diff.baseSha)} → {shortSha(diff.commitSha)}</span>
    </div>
    {view === "files" ? <div className="divide-y divide-zinc-100">{diff.files.map((file) => <div key={file.path} className="flex items-center gap-2 px-3 py-2.5"><FileCode2 size={13} className="text-zinc-400" /><span className="min-w-0 flex-1 truncate font-mono text-[10px] text-zinc-600">{file.path}</span><span className="font-mono text-[9px] text-emerald-600">+{file.additions}</span><span className="font-mono text-[9px] text-red-500">-{file.deletions}</span></div>)}</div> : <pre className="fine-scrollbar max-h-[340px] overflow-auto p-4 font-mono text-[10px] leading-[1.7] text-zinc-600">{diff.unified.split("\n").map((line, index) => <div key={index} className={cx("-mx-4 px-4", line.startsWith("+") && !line.startsWith("+++") ? "bg-emerald-50 text-emerald-800" : line.startsWith("-") && !line.startsWith("---") ? "bg-red-50 text-red-700" : line.startsWith("@@") ? "bg-blue-50 text-blue-700" : "")}>{line || " "}</div>)}</pre>}
  </div>;
}

function EmptyQueue() { return <div className="rounded-2xl border border-dashed border-zinc-200 py-9 text-center"><CheckCircle2 className="mx-auto text-zinc-300" size={22} /><div className="mt-2 text-[12px] font-medium text-zinc-500">Start the conversation</div><p className="mt-1 text-[10px] text-zinc-400">Message your team or send the agent a coding request.</p></div>; }

const AGENT_TRIGGER = /^\/agent\b\s*/i;

function HighlightedComposerText({ text }: { text: string }) {
  const match = AGENT_TRIGGER.exec(text);
  if (!match) return <>{text}</>;
  const rest = text.slice(match[0].length);
  const trailingSpace = match[0].slice("/agent".length);
  return <><span className="rounded-sm text-blue-600" style={{ boxShadow: "0 0 0 3px rgba(59,130,246,0.15)", background: "rgba(59,130,246,0.15)" }}>/agent</span>{trailingSpace}{rest}</>;
}

const Composer = forwardRef<HTMLTextAreaElement, { project: ProjectItem; user: User; replyTask: Task | null; serverMode: "connecting" | "live" | "demo"; socket: AppSocket | null; onCancelReply: () => void; onCreated: (task: Task) => void; onAttached: (result: AttachedRequestResult) => void; onMessageCreated: (message: Message) => void }>(function Composer({ project, user, replyTask, serverMode, socket, onCancelReply, onCreated, onAttached, onMessageCreated }, ref) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [explicit, setExplicit] = useState(true);
  const [error, setError] = useState("");
  const backdropRef = useRef<HTMLDivElement>(null);
  const isAgentMode = Boolean(replyTask) || AGENT_TRIGGER.test(body);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!body.trim() || sending) return;
    setSending(true); setError("");
    const raw = body.trim();
    const agentMatch = AGENT_TRIGGER.exec(raw);
    const text = agentMatch ? raw.slice(agentMatch[0].length).trim() : raw;
    try {
      if (serverMode !== "live") throw new Error("Mutex is reconnecting. Try again in a moment.");
      if (!replyTask && !agentMatch) {
        const created = await api<Message>(`/api/projects/${project.id}/messages`, { method: "POST", body: JSON.stringify({ body: text }) });
        onMessageCreated(created);
      } else {
        if (!text) throw new Error("Add a description after /agent.");
        const created = await api<Task | AttachedRequestResult>(replyTask ? "/api/refinements" : "/api/requests", { method: "POST", body: JSON.stringify(replyTask ? { projectId: project.id, parentTaskId: replyTask.id, body: text, explicit } : { projectId: project.id, body: text }) });
        if ("kind" in created) onAttached(created);
        else onCreated(created);
      }
      setBody(!replyTask && agentMatch ? "/agent " : ""); onCancelReply();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not send your message.");
    } finally { setSending(false); }
  };
  return <form onSubmit={submit} className="absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-white via-white to-transparent px-4 pb-4 pt-10 sm:px-6 lg:px-8">
    <div className="overflow-hidden rounded-[17px] border border-zinc-300 bg-white shadow-[0_16px_50px_rgba(24,24,27,.12)] transition focus-within:border-zinc-500 focus-within:ring-2 focus-within:ring-zinc-100">
      {replyTask && <div className="flex items-center gap-2 border-b border-zinc-100 bg-amber-50/70 px-3.5 py-2 text-[10px]"><MessageSquareReply size={12} className="text-amber-700" /><span className="font-medium text-amber-900">Refining Request #{replyTask.number}</span><span className="min-w-0 flex-1 truncate text-amber-700/70">{replyTask.rootMessage?.body}</span><label className="hidden items-center gap-1.5 text-[9px] text-amber-800 sm:flex"><input checked={explicit} onChange={(event) => setExplicit(event.target.checked)} type="checkbox" className="accent-zinc-900" /> Explicit reply</label><button type="button" onClick={onCancelReply} className="rounded p-1 text-amber-700 hover:bg-amber-100"><X size={12} /></button></div>}
      <div className="relative">
        <div ref={backdropRef} aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-4 pb-2 pt-3 text-[13px] leading-5 text-zinc-900">
          <HighlightedComposerText text={body} />
        </div>
        <textarea
          ref={ref}
          value={body}
          onChange={(event) => {
            const value = event.target.value;
            setBody(value.length > body.length && /^\/agent$/i.test(value) ? `${value} ` : value);
          }}
          onScroll={(event) => { if (backdropRef.current) backdropRef.current.scrollTop = event.currentTarget.scrollTop; }}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }}
          rows={2}
          placeholder={replyTask ? "Describe the change to this request…" : "Message the team, or start with /agent to create a request…"}
          className="relative block max-h-36 min-h-[66px] w-full resize-none bg-transparent px-4 pb-2 pt-3 text-[13px] leading-5 text-transparent caret-zinc-900 outline-none placeholder:text-zinc-400"
        />
      </div>
      {error && <div className="mx-3 mb-2 rounded-lg bg-red-50 px-2.5 py-2 text-[10px] text-red-700">{error}</div>}
      <div className="flex items-center gap-2 px-3 pb-3">
        <button disabled={!body.trim() || sending} className="ml-auto grid size-8 place-items-center rounded-[10px] bg-zinc-950 text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-200 disabled:text-zinc-400" aria-label={isAgentMode ? "Submit agent request" : "Send team message"}>{sending ? <LoaderCircle size={14} className="animate-spin" /> : <Send size={13} />}</button>
      </div>
    </div>
  </form>;
});

function PanelTab({ active, icon, children, onClick }: { active: boolean; icon: ReactNode; children: ReactNode; onClick: () => void }) {
  return <button onClick={onClick} className={cx("relative flex items-center gap-1.5 px-3 pb-3 pt-1 text-[10px] font-medium transition", active ? "text-zinc-900" : "text-zinc-400 hover:text-zinc-700")}>
    {icon}{children}{active && <span className="absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-zinc-900" />}
  </button>;
}

function PreviewPanel({ project, processes, mode }: { project: ProjectItem; processes: ProcessInfo[]; mode: "connecting" | "live" | "demo" }) {
  const [running, setRunning] = useState(() => processes.some((process) => process.status === "running"));
  const [viewport, setViewport] = useState<"desktop" | "mobile">("desktop");
  const [previewAction, setPreviewAction] = useState<"starting" | "stopping" | null>(null);
  const [previewError, setPreviewError] = useState("");
  const frontend = processes.find((process) => process.name.toLowerCase() === "frontend");
  const web = frontend ?? processes.find((process) => process.url);
  const previewUrl = web?.url;
  const failed = processes.some((process) => process.status === "failed" && (process.name === "install" || process.name === "frontend" || (!project.frontendCommand && process.name === "backend")));
  const processActive = processes.some((process) => process.status === "running" || process.status === "starting");
  const starting = previewAction === "starting" || processes.some((process) => process.status === "starting") || (running && !previewUrl);
  useEffect(() => {
    setRunning(processActive);
    if (previewAction === "starting" && processActive) setPreviewAction(null);
    if (previewAction === "stopping" && !processActive) setPreviewAction(null);
  }, [previewAction, processActive]);
  const togglePreview = async () => {
    const next = !running;
    setPreviewAction(next ? "starting" : "stopping");
    setPreviewError("");
    try {
      await api(`/api/projects/${project.id}/processes/${next ? "start" : "stop"}`, { method: "POST", body: JSON.stringify({ name: "preview" }) });
      if (mode === "demo") { setRunning(next); setPreviewAction(null); }
    } catch (reason) {
      setPreviewAction(null);
      setPreviewError(reason instanceof Error ? reason.message : `Could not ${next ? "start" : "stop"} this preview.`);
    }
  };
  return <div className="fine-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto">
    <div className="flex items-center justify-between px-5 py-3">
      <div className="flex items-center gap-2"><span className={cx("size-2 rounded-full", previewAction === "stopping" ? "bg-amber-400 pulse-soft" : previewUrl ? "bg-emerald-500" : failed ? "bg-red-500" : starting ? "bg-amber-400 pulse-soft" : "bg-zinc-300")} /><span className="text-[10px] font-medium">{previewAction === "stopping" ? "Stopping preview…" : previewUrl ? "Preview running" : failed ? "Preview failed" : starting ? "Starting preview…" : "Preview stopped"}</span></div>
      <div className="flex items-center gap-1"><button title="Desktop" onClick={() => setViewport("desktop")} className={cx("rounded-md p-1.5", viewport === "desktop" ? "bg-zinc-200 text-zinc-800" : "text-zinc-400")}><Laptop2 size={14} /></button><button title="Mobile" onClick={() => setViewport("mobile")} className={cx("rounded-md p-1.5", viewport === "mobile" ? "bg-zinc-200 text-zinc-800" : "text-zinc-400")}><Smartphone size={14} /></button><button disabled={Boolean(previewAction)} title={running ? "Stop preview" : "Start preview"} aria-label={running ? "Stop preview" : "Start preview"} onClick={() => void togglePreview()} className={cx("ml-1 rounded-md p-1.5 transition disabled:cursor-wait disabled:text-zinc-300", running ? "text-red-600 hover:bg-red-50 hover:text-red-700" : "text-emerald-600 hover:bg-emerald-50 hover:text-emerald-700")}>{previewAction ? <LoaderCircle size={12} className="animate-spin" /> : running ? <Square size={11} fill="currentColor" /> : <Play size={12} fill="currentColor" />}</button>{previewUrl && <a href={previewUrl} target="_blank" rel="noreferrer" className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-200 hover:text-zinc-700" title="Open preview in a new tab" aria-label="Open preview in a new tab"><ArrowUpRight size={15} /></a>}</div>
    </div>
    {previewError && <div className="mx-4 mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[9px] leading-4 text-red-700">{previewError}</div>}
    <div className={cx("rounded-xl border border-zinc-200 bg-white p-1 shadow-sm transition-all duration-300", viewport === "mobile" ? "mx-auto w-[230px]" : "mx-4")}>
      <div className="flex h-8 items-center gap-2 rounded-t-lg border-b border-zinc-100 px-2.5"><div className="flex gap-1"><i className="size-1.5 rounded-full bg-red-300" /><i className="size-1.5 rounded-full bg-amber-300" /><i className="size-1.5 rounded-full bg-emerald-300" /></div><div className="flex flex-1 items-center gap-1.5 rounded-md bg-zinc-100 px-2 py-1 font-mono text-[8px] text-zinc-400"><ShieldCheck size={8} />{previewUrl ?? "Waiting for local URL"}</div><RefreshCw size={10} className="text-zinc-400" /></div>
      <div className={cx("w-full overflow-hidden bg-[#f8f7f3] transition-all duration-300", viewport === "mobile" ? "h-[460px]" : "h-[280px]")}>
        {previewUrl ? <iframe title={`${project.name} local preview`} src={previewUrl} className="h-full w-full border-0 bg-white" sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts" /> : <div className="grid h-full place-items-center"><div className="text-center"><CirclePause size={23} className="mx-auto text-zinc-300" /><p className="mt-2 text-[10px] font-medium text-zinc-500">{starting ? "Waiting for the development server…" : "Preview stopped"}</p></div></div>}
      </div>
    </div>
    {processes.length > 0 && <div className="mx-5 mb-4 mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-zinc-100 pt-3">
      {processes.map((process) => <div key={process.name} className="flex items-center gap-1.5 text-[9px]"><span className={cx("size-1.5 shrink-0 rounded-full", process.status === "running" ? "bg-emerald-500" : process.status === "starting" ? "bg-amber-400 pulse-soft" : process.status === "failed" ? "bg-red-500" : "bg-zinc-300")} /><span className="font-medium text-zinc-500">{process.name}</span><span className="font-mono text-zinc-400">{process.port ? `:${process.port}` : process.status}</span></div>)}
    </div>}
  </div>;
}

type DirState = { entries: FileEntry[]; loading: boolean; error?: string };

function FilesPanel({ project }: { project: ProjectItem }) {
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<{ content: string; truncated: boolean; binary: boolean } | "loading" | "error" | null>(null);

  const loadDir = async (path: string) => {
    setDirs((current) => ({ ...current, [path]: { entries: current[path]?.entries ?? [], loading: true } }));
    try {
      const result = await api<ListDirectoryResponse>(`/api/projects/${project.id}/files?path=${encodeURIComponent(path)}`);
      setDirs((current) => ({ ...current, [path]: result.ok ? { entries: result.entries, loading: false } : { entries: [], loading: false, error: result.error } }));
    } catch (error) {
      setDirs((current) => ({ ...current, [path]: { entries: [], loading: false, error: error instanceof Error ? error.message : "Could not load this directory." } }));
    }
  };

  useEffect(() => { setDirs({}); setExpanded(new Set()); setSelected(null); setFile(null); void loadDir(""); }, [project.id]);

  const toggle = (path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else { next.add(path); if (!dirs[path]) void loadDir(path); }
      return next;
    });
  };

  const openFile = async (path: string) => {
    setSelected(path); setFile("loading");
    try {
      const result = await api<ReadFileResponse>(`/api/projects/${project.id}/files/content?path=${encodeURIComponent(path)}`);
      setFile(result.ok ? { content: result.content, truncated: result.truncated, binary: result.binary } : "error");
    } catch { setFile("error"); }
  };

  const root = dirs[""];
  return <div className="flex min-h-0 flex-1">
    <div className="fine-scrollbar w-[190px] shrink-0 overflow-y-auto border-r border-zinc-200 py-2">
      {!root || (root.loading && !root.entries.length) ? <div className="px-3 py-2 text-[10px] text-zinc-400">Loading…</div>
        : root.error ? <div className="px-3 py-2 text-[10px] text-red-500">{root.error}</div>
        : root.entries.length ? root.entries.map((entry) => <FileTreeNode key={entry.path} entry={entry} depth={0} expanded={expanded} dirs={dirs} selected={selected} onToggle={toggle} onSelect={(path) => void openFile(path)} />)
        : <div className="px-3 py-2 text-[10px] text-zinc-400">Empty repository</div>}
    </div>
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {!selected ? <div className="grid h-full place-items-center px-6 text-center text-[10px] text-zinc-400">Select a file to view its contents</div>
        : file === "loading" ? <div className="grid h-full place-items-center text-[10px] text-zinc-400">Loading…</div>
        : file === "error" || !file ? <div className="grid h-full place-items-center px-6 text-center text-[10px] text-red-500">Could not load this file</div>
        : file.binary ? <div className="grid h-full place-items-center px-6 text-center text-[10px] text-zinc-400">Binary file — preview not available</div>
        : <CodeViewer path={selected} content={file.content} truncated={file.truncated} />}
    </div>
  </div>;
}

function FileTreeNode({ entry, depth, expanded, dirs, selected, onToggle, onSelect }: { entry: FileEntry; depth: number; expanded: Set<string>; dirs: Record<string, DirState>; selected: string | null; onToggle: (path: string) => void; onSelect: (path: string) => void }) {
  const isDir = entry.type === "directory";
  const isOpen = expanded.has(entry.path);
  const state = dirs[entry.path];
  return <div>
    <button onClick={() => (isDir ? onToggle(entry.path) : onSelect(entry.path))} style={{ paddingLeft: 10 + depth * 12 }} className={cx("flex w-full items-center gap-1.5 py-1 pr-2 text-left text-[11px] hover:bg-zinc-100", !isDir && selected === entry.path && "bg-zinc-100 font-medium text-zinc-900")}>
      {isDir ? (isOpen ? <ChevronDown size={11} className="shrink-0 text-zinc-400" /> : <ChevronRight size={11} className="shrink-0 text-zinc-400" />) : <span className="w-[11px] shrink-0" />}
      {isDir ? <Folder size={12} className="shrink-0 text-zinc-400" /> : <FileCode2 size={12} className="shrink-0 text-zinc-400" />}
      <span className="truncate text-zinc-700">{entry.name}</span>
    </button>
    {isDir && isOpen && (!state || (state.loading && !state.entries.length) ? <div style={{ paddingLeft: 22 + depth * 12 }} className="py-1 text-[10px] text-zinc-400">Loading…</div>
      : state.error ? <div style={{ paddingLeft: 22 + depth * 12 }} className="py-1 text-[10px] text-red-500">{state.error}</div>
      : state.entries.map((child) => <FileTreeNode key={child.path} entry={child} depth={depth + 1} expanded={expanded} dirs={dirs} selected={selected} onToggle={onToggle} onSelect={onSelect} />))}
  </div>;
}

function CodeViewer({ path, content, truncated }: { path: string; content: string; truncated: boolean }) {
  const lines = useMemo(() => content.split("\n"), [content]);
  const gutterRef = useRef<HTMLDivElement>(null);
  return <div className="flex h-full flex-col">
    <div className="flex items-center gap-1.5 border-b border-zinc-100 px-3 py-2 text-[10px] font-medium text-zinc-500"><FileCode2 size={12} className="shrink-0 text-zinc-400" /><span className="truncate font-mono">{path}</span>{truncated && <span className="ml-auto shrink-0 rounded-full bg-amber-50 px-1.5 py-0.5 text-[8px] font-medium text-amber-600">Truncated</span>}</div>
    <div className="flex min-h-0 flex-1">
      <div ref={gutterRef} className="select-none overflow-hidden border-r border-zinc-100 bg-zinc-50/60 px-2 py-2 text-right font-mono text-[10px] leading-5 text-zinc-300">
        {lines.map((_, index) => <div key={index}>{index + 1}</div>)}
      </div>
      <textarea
        readOnly
        value={content}
        spellCheck={false}
        wrap="off"
        onScroll={(event) => { if (gutterRef.current) gutterRef.current.scrollTop = event.currentTarget.scrollTop; }}
        className="fine-scrollbar min-h-0 min-w-0 flex-1 resize-none overflow-auto whitespace-pre bg-transparent px-3 py-2 font-mono text-[10px] leading-5 text-zinc-700 outline-none"
      />
    </div>
  </div>;
}

function GitHistoryPanel({ project }: { project: ProjectItem }) {
  const [state, setState] = useState<"loading" | "error" | Extract<GitHistoryResponse, { ok: true }>>("loading");
  const [errorMessage, setErrorMessage] = useState("");
  useEffect(() => {
    let cancelled = false;
    setState("loading");
    api<GitHistoryResponse>(`/api/projects/${project.id}/git/history`).then((result) => {
      if (cancelled) return;
      if (result.ok) setState(result);
      else { setState("error"); setErrorMessage(result.error); }
    }).catch((error) => { if (!cancelled) { setState("error"); setErrorMessage(error instanceof Error ? error.message : "Could not load git history."); } });
    return () => { cancelled = true; };
  }, [project.id]);

  if (state === "loading") return <div className="grid flex-1 place-items-center text-[10px] text-zinc-400">Loading history…</div>;
  if (state === "error") return <div className="grid flex-1 place-items-center px-6 text-center text-[10px] text-red-500">{errorMessage}</div>;

  return <div className="fine-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto">
    <div className="flex flex-wrap gap-1.5 border-b border-zinc-100 px-4 py-3">
      {state.branches.map((branch) => <span key={branch.name} className={cx("flex items-center gap-1 rounded-full px-2 py-1 text-[9px] font-medium", branch.current ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-600")}><GitBranch size={10} />{branch.name}</span>)}
    </div>
    <div className="flex-1 px-4 py-3">
      {state.commits.map((commit, index) => <div key={commit.sha} className="relative flex gap-3">
        <div className="flex flex-col items-center">
          <span className="mt-1 size-2 shrink-0 rounded-full border-2 border-zinc-900 bg-white" />
          {index < state.commits.length - 1 && <span className="w-px flex-1 bg-zinc-200" />}
        </div>
        <div className="min-w-0 flex-1 pb-4">
          <div className="flex items-center gap-2">
            <span className="truncate text-[11px] font-medium text-zinc-800">{commit.message}</span>
            {commit.refs.map((ref) => <span key={ref} className="shrink-0 rounded-full bg-blue-50 px-1.5 py-0.5 text-[8px] font-medium text-blue-600">{ref}</span>)}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[9px] text-zinc-400">
            <span className="font-mono">{commit.sha.slice(0, 7)}</span><span>{commit.author}</span><span>{new Date(commit.date).toLocaleString()}</span>
          </div>
        </div>
      </div>)}
      {!state.commits.length && <div className="py-6 text-center text-[10px] text-zinc-400">No commits found.</div>}
    </div>
  </div>;
}

function ActivityPanel({ activity }: { activity: Activity[] }) {
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [activity.length]);
  const categoryColor: Record<string, string> = { REQUEST: "text-blue-300", GIT: "text-violet-300", AGENT: "text-amber-300", REFINE: "text-orange-300", TEST: "text-emerald-300", SYNC: "text-cyan-300", TASK: "text-zinc-100" };
  return <div className="flex min-h-0 flex-1 flex-col bg-[#151515] text-zinc-300">
    <div className="fine-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-3 font-mono text-[9px] leading-6">
      {activity.map((event) => {
        const date = new Date(event.createdAt); const user = event.user?.username ?? (event.userId || "system");
        return <div key={event.id} className="grid grid-cols-[56px_50px_47px_minmax(0,1fr)] gap-1 border-b border-white/[.035] py-0.5 hover:bg-white/[.03]"><span className="text-zinc-600">{date.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span><span className="truncate text-zinc-500">{user}</span><span className={cx("font-medium", categoryColor[event.category] ?? "text-zinc-400")}>{event.category}</span><span className="break-words text-zinc-300">{event.message}</span></div>;
      })}
      <div aria-hidden className="h-[108px]" />
      <div ref={bottom} />
    </div>
  </div>;
}

function Avatar({ user, size = "md", online, ring }: { user: Pick<User, "name" | "username" | "avatarUrl">; size?: "xs" | "sm" | "md"; online?: boolean; ring?: boolean }) {
  const dimensions = size === "xs" ? "size-6 text-[8px]" : size === "sm" ? "size-8 text-[9px]" : "size-9 text-[10px]";
  const initials = user.name.split(" ").map((word) => word[0]).join("").slice(0, 2).toUpperCase();
  const palette = user.username === "alice" ? "bg-[#2d3033]" : user.username === "bob" ? "bg-[#806946]" : "bg-[#777984]";
  return <div className={cx("relative grid shrink-0 place-items-center rounded-full font-semibold text-white", dimensions, palette, ring && "ring-2 ring-white")}>
    {user.avatarUrl ? <img src={user.avatarUrl} alt="" className="size-full rounded-full object-cover" /> : initials}
    {online !== undefined && <span className={cx("absolute bottom-0 right-0 size-2 rounded-full ring-2 ring-white", online ? "bg-emerald-500" : "bg-zinc-300")} />}
  </div>;
}

function Modal({ children, onClose, width = "max-w-xl" }: { children: ReactNode; onClose: () => void; width?: string }) {
  useEffect(() => { const handler = (event: KeyboardEvent) => event.key === "Escape" && onClose(); window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler); }, [onClose]);
  return <div className="fixed inset-0 z-[80] grid place-items-center bg-zinc-950/30 p-3 backdrop-blur-[2px]" role="dialog" aria-modal="true" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className={cx("enter-up fine-scrollbar max-h-[calc(100vh-24px)] w-full overflow-y-auto rounded-[22px] border border-white/80 bg-white shadow-float", width)}>{children}</div></div>;
}

function ModalHeader({ icon, title, description, onClose }: { icon: ReactNode; title: string; description?: string; onClose: () => void }) {
  return <div className={cx("flex gap-3 border-b border-zinc-100 px-5 py-5 sm:px-6", description ? "items-start" : "items-center")}><div className="grid size-9 shrink-0 place-items-center rounded-xl bg-zinc-100 text-zinc-700">{icon}</div><div><h3 className="text-[15px] font-semibold tracking-tight">{title}</h3>{description && <p className="mt-1 text-[10px] leading-4 text-zinc-400">{description}</p>}</div><button onClick={onClose} className="ml-auto rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100"><X size={17} /></button></div>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) { return <label className="block"><span className="text-[10px] font-semibold text-zinc-700">{label}</span>{hint && <span className="ml-2 text-[9px] text-zinc-400">{hint}</span>}<div className="mt-1.5">{children}</div></label>; }
const fieldClass = "h-10 w-full rounded-xl border border-zinc-200 bg-white px-3 text-[11px] text-zinc-700 outline-none transition focus:border-zinc-500 focus:ring-2 focus:ring-zinc-100";

function CreateProjectModal({ user, onClose, onCreated }: { user: User; onClose: () => void; onCreated: (project: Project) => void }) {
  const [name, setName] = useState("");
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [repositories, setRepositories] = useState<GithubRepository[]>([]);
  const [loadingRepositories, setLoadingRepositories] = useState(true);
  const [manualEntry, setManualEntry] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    void api<{ repositories?: Array<GithubRepository & { full_name?: string; clone_url?: string; default_branch?: string; permissions?: { push?: boolean } }> }>("/api/github/repositories")
      .then((payload) => {
        const normalized = (payload.repositories ?? []).map((repository) => ({
          ...repository,
          fullName: repository.fullName ?? repository.full_name ?? `${repository.owner}/${repository.name}`,
          cloneUrl: repository.cloneUrl ?? repository.clone_url ?? `https://github.com/${repository.fullName ?? repository.full_name}.git`,
          defaultBranch: repository.defaultBranch ?? repository.default_branch ?? "main",
        })).filter((repository) => repository.canWrite !== false && repository.permissions?.push !== false);
        setRepositories(normalized);
        if (normalized.length === 0) setManualEntry(true);
      })
      .catch((reason: unknown) => {
        setManualEntry(true);
        setError(reason instanceof Error ? reason.message : "GitHub repositories could not be loaded. Reconnect GitHub and try again.");
      })
      .finally(() => setLoadingRepositories(false));
  }, []);
  const chooseRepository = (value: string) => {
    const repository = repositories.find((item) => item.fullName === value);
    if (!repository) return;
    setRepositoryUrl(repository.cloneUrl);
    setBranch(repository.defaultBranch);
    if (!name) setName(repository.name.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()));
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError("");
    try {
      const result = await api<{ project: Project }>("/api/projects", { method: "POST", body: JSON.stringify({ name, repositoryUrl, branch }) });
      onCreated(result.project);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not create project"); setSaving(false); }
  };
  return <Modal onClose={onClose} width="max-w-lg"><ModalHeader icon={<FolderGit2 size={16} />} title="Create project" description="Choose a GitHub repository you can write to." onClose={onClose} />
    <form onSubmit={submit}><div className="space-y-4 p-5 sm:p-6">
      {!manualEntry && <Field label="GitHub repository" hint="Only repositories with write access are shown"><div className="relative"><Github size={13} className="absolute left-3 top-3.5 text-zinc-400" /><select disabled={loadingRepositories} value={repositories.find((repository) => repository.cloneUrl === repositoryUrl)?.fullName ?? ""} onChange={(event) => chooseRepository(event.target.value)} className={cx(fieldClass, "pl-9")}><option value="">{loadingRepositories ? "Loading repositories…" : "Choose a repository"}</option>{repositories.map((repository) => <option key={repository.id} value={repository.fullName}>{repository.fullName}{repository.private ? " · private" : ""}</option>)}</select></div></Field>}
      {manualEntry && <div className="flex items-center justify-between rounded-xl border border-zinc-200 bg-zinc-50 p-3"><div><div className="text-[10px] font-medium text-zinc-700">GitHub repositories unavailable</div><div className="mt-0.5 text-[9px] text-zinc-400">Connect GitHub to choose from a verified list.</div></div><button type="button" onClick={beginGithubLogin} className="rounded-lg bg-zinc-950 px-3 py-2 text-[9px] font-medium text-white">Connect GitHub</button></div>}
      <Field label="Project name"><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Payments dashboard" className={fieldClass} /></Field>
      {manualEntry && <Field label="GitHub repository URL" hint="Validated when the project is created"><input value={repositoryUrl} onChange={(event) => setRepositoryUrl(event.target.value)} placeholder="https://github.com/owner/repository.git" className={cx(fieldClass, "font-mono")} /></Field>}
      <Field label="Branch"><div className="relative"><GitBranch size={13} className="absolute left-3 top-3.5 text-zinc-400" /><input value={branch} onChange={(event) => setBranch(event.target.value)} className={cx(fieldClass, "pl-9 font-mono")} /></div></Field>
      <div className="flex gap-2 rounded-xl border border-blue-100 bg-blue-50/60 p-3 text-[9px] leading-4 text-blue-900"><RefreshCw size={13} className="mt-0.5 shrink-0" /><span>Mutex will inspect this branch and detect its install, frontend, backend, and validation commands. You can review or change them in Project Settings.</span></div>
      <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-[9px] leading-4 text-zinc-500">You become the project owner. Mutex verifies repository access before adding members or running requests.</div>
      {error && <p className="text-[10px] text-red-600">{error}</p>}
    </div><div className="flex items-center justify-between border-t border-zinc-100 px-5 py-4 sm:px-6"><span className="text-[9px] text-zinc-400">Creating as @{user.username}</span><div className="flex gap-2"><button type="button" onClick={onClose} className="rounded-xl px-4 py-2.5 text-[10px] font-medium text-zinc-500">Cancel</button><button disabled={saving || !name.trim() || !repositoryUrl.trim() || !branch.trim()} className="rounded-xl bg-zinc-950 px-4 py-2.5 text-[10px] font-medium text-white disabled:bg-zinc-300">{saving ? "Detecting & creating…" : "Create project"}</button></div></div></form>
  </Modal>;
}

function ProjectSettingsModal({ project, onClose, onInitialize, onSave }: { project: ProjectItem; onClose: () => void; onInitialize: () => void; onSave: (project: ProjectItem) => void }) {
  const [draft, setDraft] = useState(() => ({ ...project, coordinatorModel: project.coordinatorModel.startsWith("gpt-") ? project.coordinatorModel : "gpt-5-mini" }));
  const [agentCredential, setAgentCredential] = useState("");
  const [clearAgentCredential, setClearAgentCredential] = useState(false);
  const [tab, setTab] = useState<"repository" | "agent" | "commands">("repository");
  const [detectingCommands, setDetectingCommands] = useState(false);
  const [commandDetectionMessage, setCommandDetectionMessage] = useState("");
  const [commandDetectionFailed, setCommandDetectionFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [permissions, setPermissions] = useState<Record<string, boolean>>({ "File read": project.toolPermissions?.fileRead ?? true, "File write": project.toolPermissions?.fileWrite ?? true, Shell: project.toolPermissions?.shell ?? true, Git: project.toolPermissions?.git ?? true, Tests: project.toolPermissions?.tests ?? true, Network: project.toolPermissions?.network ?? false });
  const save = async () => {
    if (saving) return;
    const toolPermissions = { fileRead: permissions["File read"] ?? false, fileWrite: permissions["File write"] ?? false, shell: permissions.Shell ?? false, git: permissions.Git ?? false, tests: permissions.Tests ?? false, network: permissions.Network ?? false };
    setSaving(true);
    setSaveError("");
    try {
      const result = await api<{ project: Project }>(`/api/projects/${project.id}/settings`, { method: "PATCH", body: JSON.stringify({ branch: draft.branch, coordinatorModel: draft.coordinatorModel, developerModel: draft.developerModel, installCommand: draft.installCommand, frontendCommand: draft.frontendCommand, backendCommand: draft.backendCommand, testCommand: draft.testCommand, toolPermissions, ...(agentCredential ? { agentCredential } : {}), ...(clearAgentCredential ? { clearAgentCredential: true } : {}) }) });
      onSave({ ...project, ...result.project, members: project.members, onlineCount: project.onlineCount });
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : "Project settings could not be saved.");
      setSaving(false);
    }
  };
  const detectCommands = async () => {
    setDetectingCommands(true);
    setCommandDetectionMessage("");
    setCommandDetectionFailed(false);
    try {
      const result = await api<{ commands: InferredCommands }>(`/api/projects/${project.id}/infer-commands`, { method: "POST", body: JSON.stringify({ branch: draft.branch }) });
      setDraft((current) => ({ ...current, ...result.commands }));
      const sources = result.commands.detectedFrom.length ? ` Sources: ${result.commands.detectedFrom.join(", ")}.` : "";
      const method = result.commands.inferenceMethod === "agent" ? "The project agent inferred the commands." : "Repository conventions were used.";
      const diagnostics = result.commands.diagnostics?.join(" ") ?? "";
      setCommandDetectionMessage(`${method} ${diagnostics}${sources} Review them, then save changes.`.replace(/\s+/g, " "));
    } catch (reason) {
      setCommandDetectionFailed(true);
      setCommandDetectionMessage(reason instanceof Error ? reason.message : "Could not inspect this repository.");
    } finally {
      setDetectingCommands(false);
    }
  };
  return <Modal onClose={onClose} width="max-w-2xl"><ModalHeader icon={<Settings size={16} />} title="Project settings" onClose={onClose} />
    <div className="flex border-b border-zinc-100 px-5 sm:px-6">{(["repository", "agent", "commands"] as const).map((item) => <button key={item} onClick={() => setTab(item)} className={cx("relative px-3 py-3 text-[10px] font-medium capitalize", tab === item ? "text-zinc-900" : "text-zinc-400")}>{item}{tab === item && <span className="absolute inset-x-2 bottom-0 h-[2px] bg-zinc-900" />}</button>)}</div>
    <div className="min-h-[370px] p-5 sm:p-6">
      {tab === "repository" && <div className="space-y-5"><div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4"><div className="flex items-center gap-2 text-[11px] font-semibold"><Github size={15} /> {project.repositoryOwner}/{project.repositoryName}<span className="ml-auto flex items-center gap-1 text-[9px] font-medium text-emerald-700"><CheckCircle2 size={11} /> Write access verified</span></div><p className="mt-2 text-[9px] leading-4 text-zinc-500">The remote branch is the source of truth. Every companion hard-resets tracked files before execution.</p></div><div className="grid gap-4 sm:grid-cols-2"><Field label="Repository owner"><input disabled value={project.repositoryOwner} className={cx(fieldClass, "bg-zinc-50 text-zinc-400")} /></Field><Field label="Repository"><input disabled value={project.repositoryName} className={cx(fieldClass, "bg-zinc-50 text-zinc-400")} /></Field></div><Field label="Configured branch" hint="History rewriting must be allowed for rollback"><div className="relative"><GitBranch size={13} className="absolute left-3 top-3.5 text-zinc-400" /><input value={draft.branch} onChange={(event) => setDraft({ ...draft, branch: event.target.value })} className={cx(fieldClass, "pl-9")} /></div></Field><div className="flex gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[9px] leading-4 text-amber-900"><AlertTriangle size={14} className="mt-0.5 shrink-0" /> Destructive rollback rewrites this branch with force-with-lease. Protected branches may reject the operation safely.</div></div>}
      {tab === "agent" && <div className="space-y-5"><div className="grid gap-4 sm:grid-cols-2"><Field label="Coordinator model" hint="Classifies active-task refinements"><select value={draft.coordinatorModel.startsWith("gpt-") ? draft.coordinatorModel : "gpt-5-mini"} onChange={(event) => setDraft({ ...draft, coordinatorModel: event.target.value })} className={fieldClass}><option value="gpt-5-mini">GPT-5 mini</option><option value="gpt-5">GPT-5</option><option value="gpt-4.1-mini">GPT-4.1 mini</option></select></Field><Field label="Developer model" hint="Runs locally"><select value={draft.developerModel} onChange={(event) => setDraft({ ...draft, developerModel: event.target.value })} className={fieldClass}><option value="gpt-5.6-sol">GPT-5.6 Sol (OpenAI)</option><option value="local-agent">OpenAI agent (default model)</option><option value="command" disabled>Local command agent — Coming soon</option><option value="demo">Demo only (placeholder change)</option></select></Field></div>{!["demo", "command"].includes(draft.developerModel) && !project.agentCredentialConfigured && !agentCredential && <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-[10px] leading-4 text-red-700"><AlertTriangle size={14} className="mt-0.5 shrink-0" /><span><strong>OpenAI key required.</strong> Coding requests cannot start until a project owner saves the shared key below.</span></div>}<Field label={project.agentCredentialConfigured ? "Replace shared OpenAI key (optional)" : "Shared OpenAI key"} hint="Used by both the coordinator and local developer agent"><input type="password" autoComplete="off" value={agentCredential} disabled={clearAgentCredential} onChange={(event) => setAgentCredential(event.target.value)} placeholder={project.agentCredentialConfigured ? "••••••••••••••••  (configured)" : "sk-…"} className={fieldClass} /></Field><div className="flex items-center justify-between rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5"><div><div className="text-[10px] font-medium text-zinc-700">{project.agentCredentialConfigured && !clearAgentCredential ? "Shared key configured" : "No shared key configured"}</div><div className="mt-0.5 text-[9px] text-zinc-400">The key is never returned to browsers or written to activity logs.</div></div>{project.agentCredentialConfigured && <button type="button" onClick={() => { setClearAgentCredential((value) => !value); setAgentCredential(""); }} className={cx("rounded-lg px-3 py-1.5 text-[9px] font-medium", clearAgentCredential ? "bg-red-600 text-white" : "border border-zinc-200 bg-white text-red-600")}>{clearAgentCredential ? "Will remove on save" : "Remove key"}</button>}</div><div><div className="text-[10px] font-semibold text-zinc-700">Tool permissions</div><div className="mt-2 divide-y divide-zinc-100 rounded-xl border border-zinc-200 px-3">{Object.entries(permissions).map(([name, enabled]) => <label key={name} className="flex items-center py-2.5 text-[10px]"><span className="text-zinc-600">{name}</span><button type="button" aria-pressed={enabled} onClick={() => setPermissions({ ...permissions, [name]: !enabled })} className={cx("ml-auto h-5 w-9 rounded-full p-0.5 transition", enabled ? "bg-zinc-900" : "bg-zinc-200")}><span className={cx("block size-4 rounded-full bg-white shadow-sm transition-transform", enabled && "translate-x-4")} /></button></label>)}</div></div></div>}
      {tab === "commands" && <div className="space-y-4">
        <div className="flex items-center justify-between gap-4 rounded-xl border border-zinc-900 bg-zinc-950 p-4 text-white"><div><div className="flex items-center gap-2 text-[11px] font-semibold"><Zap size={13} fill="currentColor" /> Initialize or complete setup</div><p className="mt-1 text-[9px] leading-4 text-zinc-400">Works for new repositories and existing websites whose run or validation commands are missing. Existing application code is preserved.</p></div><button type="button" onClick={onInitialize} className="shrink-0 rounded-lg bg-white px-3 py-2 text-[9px] font-semibold text-zinc-950 hover:bg-zinc-100">Choose stack</button></div>
        <div className="flex items-start justify-between gap-4 rounded-xl border border-zinc-200 bg-zinc-50 p-3"><p className="text-[10px] leading-4 text-zinc-500">Mutex inspects manifests, README instructions, workspace files, Makefiles, environment examples, and CI configuration. When a shared OpenAI key is configured, the project agent selects the best repository-grounded commands. Every result remains editable.</p><button type="button" disabled={detectingCommands} onClick={() => void detectCommands()} className="flex shrink-0 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-[9px] font-medium text-zinc-700 shadow-sm hover:bg-zinc-50 disabled:text-zinc-300"><RefreshCw size={11} className={detectingCommands ? "animate-spin" : ""} />{detectingCommands ? "Agent inspecting…" : "Infer again"}</button></div>
        {commandDetectionMessage && <p className={cx("rounded-lg px-3 py-2 text-[9px] leading-4", commandDetectionFailed ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700")}>{commandDetectionMessage}</p>}
        {(["installCommand", "frontendCommand", "backendCommand", "testCommand"] as const).map((key) => <Field key={key} label={key.replace("Command", " command").replace(/^./, (character) => character.toUpperCase())} hint={key === "testCommand" ? "Must succeed before a push" : undefined}><div className="relative"><TerminalSquare size={13} className="absolute left-3 top-3.5 text-zinc-400" /><input value={draft[key] ?? ""} onChange={(event) => setDraft({ ...draft, [key]: event.target.value || null })} placeholder={key === "installCommand" ? "npm install" : key === "frontendCommand" ? "npm run dev" : key === "backendCommand" ? "npm run server" : "npm test"} className={cx(fieldClass, "pl-9 font-mono")} /></div></Field>)}
      </div>}
    </div>
    <div className="border-t border-zinc-100 px-5 py-4 sm:px-6">{saveError && <div className="mb-3 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-[10px] leading-4 text-red-700"><AlertTriangle size={13} className="mt-0.5 shrink-0" />{saveError}</div>}<div className="flex items-center justify-end gap-2"><button onClick={onClose} disabled={saving} className="rounded-xl px-4 py-2.5 text-[10px] font-medium text-zinc-500 hover:bg-zinc-50 disabled:opacity-50">Cancel</button><button onClick={() => void save()} disabled={saving} className="rounded-xl bg-zinc-950 px-4 py-2.5 text-[10px] font-medium text-white disabled:bg-zinc-400">{saving ? "Saving…" : "Save changes"}</button></div></div>
  </Modal>;
}

function InitializeRepositoryModal({ project, onClose, onStarted }: { project: ProjectItem; onClose: () => void; onStarted: () => void }) {
  const [frontend, setFrontend] = useState<RepositoryFrontend>("REACT");
  const [backend, setBackend] = useState<RepositoryBackend>("EXPRESS");
  const [database, setDatabase] = useState<RepositoryDatabase>("POSTGRESQL");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      await api(`/api/projects/${project.id}/initialize`, {
        method: "POST",
        body: JSON.stringify({ projectId: project.id, frontend, backend, database }),
      });
      onStarted();
    } catch (reason) {
      let message = reason instanceof Error ? reason.message : "Could not initialize this repository.";
      try { message = JSON.parse(message).error ?? message; } catch { /* plain server response */ }
      setError(message);
      setSaving(false);
    }
  };
  return <Modal onClose={onClose} width="max-w-lg">
    <ModalHeader icon={<Zap size={16} />} title="Initialize or complete setup" description="Choose the stack. Mutex preserves an existing site and fills in missing setup commands." onClose={onClose} />
    <form onSubmit={submit}>
      <div className="space-y-4 p-5 sm:p-6">
        <div className="flex gap-2 rounded-xl border border-blue-100 bg-blue-50/70 p-3 text-[9px] leading-4 text-blue-900"><ShieldCheck size={13} className="mt-0.5 shrink-0" /><span>This setup run does not require or run a pre-existing validation command. Mutex inspects and preserves an existing application, fills in missing setup, then saves the detected install, preview, and validation commands.</span></div>
        <Field label="Frontend"><select autoFocus value={frontend} onChange={(event) => setFrontend(event.target.value as RepositoryFrontend)} className={fieldClass}><option value="REACT">React</option><option value="NEXT_JS">Next.js</option><option value="VUE">Vue</option><option value="SVELTE">Svelte</option><option value="NONE">No frontend</option></select></Field>
        <Field label="Backend"><select value={backend} onChange={(event) => setBackend(event.target.value as RepositoryBackend)} className={fieldClass}><option value="EXPRESS">Express</option><option value="FASTIFY">Fastify</option><option value="NEST_JS">NestJS</option><option value="FASTAPI">FastAPI</option><option value="DJANGO">Django</option><option value="NONE">No backend</option></select></Field>
        <Field label="Database"><select value={database} onChange={(event) => setDatabase(event.target.value as RepositoryDatabase)} className={fieldClass}><option value="POSTGRESQL">PostgreSQL</option><option value="MYSQL">MySQL</option><option value="SQLITE">SQLite</option><option value="MONGODB">MongoDB</option><option value="NONE">No database</option></select></Field>
        <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-[9px] leading-4 text-zinc-500"><strong className="text-zinc-700">Remote target:</strong> {project.repositoryOwner}/{project.repositoryName} · {project.branch}</div>
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-[10px] text-red-700">{error}</p>}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-zinc-100 px-5 py-4 sm:px-6"><button type="button" onClick={onClose} className="rounded-xl px-4 py-2.5 text-[10px] font-medium text-zinc-500 hover:bg-zinc-50">Cancel</button><button disabled={saving} className="flex items-center gap-2 rounded-xl bg-zinc-950 px-4 py-2.5 text-[10px] font-medium text-white disabled:bg-zinc-300">{saving && <LoaderCircle size={12} className="animate-spin" />}{saving ? "Starting…" : "Initialize repository"}</button></div>
    </form>
  </Modal>;
}

function UserSettingsModal({ projects, user, socket, onClose, onUpdated }: { projects: ProjectItem[]; user: User; socket: AppSocket | null; onClose: () => void; onUpdated: (user: User) => void }) {
  const [settings, setSettings] = useState<{ online: boolean; version?: string; mappings: Record<string, string> }>({ online: false, mappings: {} });
  const [companionMessage, setCompanionMessage] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const detectedPlatform = /windows/i.test(navigator.userAgent) ? "win32" : /linux|x11/i.test(navigator.userAgent) ? "linux" : "darwin";
  const platformLabel = detectedPlatform === "win32" ? "Windows" : detectedPlatform === "linux" ? "Linux" : "macOS";
  const companionDownloads = [{ platform: "darwin", label: "macOS" }, { platform: "win32", label: "Windows" }, { platform: "linux", label: "Linux" }];
  const chooseSkin = (skinId: PixelSkinId) => {
    socket?.emit("UPDATE_USER_APPEARANCE", { pixelCharacter: skinId });
    onUpdated({ ...user, pixelCharacter: skinId });
  };
  useEffect(() => {
    void api<{ localCompanion: { online: boolean }; mappings: Array<{ projectId: string; path?: string | null; version?: string | null }> }>("/api/users/me/settings").then((payload) => {
      setSettings((current) => ({ ...current, online: payload.localCompanion.online, version: payload.mappings.find((item) => item.version)?.version ?? undefined, mappings: Object.fromEntries(payload.mappings.filter((item) => item.path).map((item) => [item.projectId, item.path!])) }));
    }).catch(() => undefined);
  }, []);
  const connectProject = async (project: ProjectItem) => {
    setCompanionMessage("");
    try {
      const result = await api<{ code: string; expiresAt: string }>("/api/companion/pair/start", { method: "POST" });
      setPairingCode(result.code);
      window.location.assign(companionDeepLink(result.code));
    } catch {
      setCompanionMessage("Install or open Mutex Companion, then try again.");
    }
  };
  return <Modal onClose={onClose} width="max-w-2xl"><ModalHeader icon={<UserRound size={16} />} title="Personal settings" description="Your Git identity and local companion stay private to this machine." onClose={onClose} />
    <div className="space-y-6 p-5 sm:p-6">
      <section>
        <div className="mb-2 text-[9px] font-semibold uppercase tracking-[.13em] text-zinc-400">Chat character</div>
        <div className="rounded-xl border border-zinc-200 p-4">
          <p className="text-[9px] leading-4 text-zinc-500">Shown in the bottom-right crew overlay whenever you're the one running a request.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {PIXEL_SKINS.map((skin) => {
              const selected = (user.pixelCharacter ?? PIXEL_SKINS[0]!.id) === skin.id;
              return <button key={skin.id} type="button" onClick={() => chooseSkin(skin.id)} title={skin.label} className={cx("grid size-24 place-items-center rounded-xl border-2 bg-white transition", selected ? "border-zinc-900 shadow-sm" : "border-transparent hover:border-zinc-200")}>
                <PixelAvatar skinId={skin.id} size={60} />
              </button>;
            })}
          </div>
        </div>
      </section>
      <section><div className="mb-2 text-[9px] font-semibold uppercase tracking-[.13em] text-zinc-400">Git identity</div><div className="rounded-xl border border-zinc-200 p-4"><div className="flex items-center gap-3"><div className="grid size-9 place-items-center rounded-full bg-zinc-950 text-white"><Github size={17} /></div><div><div className="text-[11px] font-semibold">@{user.username}</div><div className="mt-0.5 text-[9px] text-zinc-400">Commit identity comes from your local Git configuration</div></div><span className="ml-auto text-[9px] font-medium text-zinc-500">Kept local</span></div><div className="mt-3 flex items-center justify-between border-t border-zinc-100 pt-3 text-[9px] text-zinc-400"><span>Credentials never pass through the browser or activity logs.</span><button onClick={() => void logout()} className="font-medium text-red-600 hover:underline">Log out</button></div></div></section>
      <section><div className="mb-2 text-[9px] font-semibold uppercase tracking-[.13em] text-zinc-400">Local companion</div><div className="rounded-xl border border-zinc-200 p-4"><div className="flex items-center gap-3"><div className={cx("grid size-9 place-items-center rounded-xl", settings.online ? "bg-emerald-50 text-emerald-700" : "bg-zinc-100 text-zinc-500")}><Laptop2 size={17} /></div><div className="min-w-0 flex-1"><div className="flex items-center gap-2 text-[11px] font-semibold">This machine <span className={cx("size-1.5 rounded-full", settings.online ? "bg-emerald-500" : "bg-zinc-300")} /></div><div className="mt-0.5 text-[9px] text-zinc-400">{settings.online ? `Online${settings.version ? ` · companion v${settings.version}` : ""}` : "Companion not connected"}</div></div>{!settings.online && <a href={`${API_URL}/api/companion/download?platform=${detectedPlatform}`} className="flex items-center gap-1.5 rounded-lg bg-zinc-950 px-3 py-2 text-[9px] font-medium text-white"><ArrowDown size={11} /> Download for {platformLabel}</a>}</div><div className="mt-3 flex items-center gap-2 border-t border-zinc-100 pt-3"><span className="mr-auto text-[9px] text-zinc-400">Also available for</span>{companionDownloads.map((download) => <a key={download.platform} href={`${API_URL}/api/companion/download?platform=${download.platform}`} className={cx("rounded-md px-2 py-1 text-[9px] font-medium", download.platform === detectedPlatform ? "bg-zinc-100 text-zinc-500" : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800")}>{download.label}</a>)}</div></div>{pairingCode && <div className="mt-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-[9px] text-emerald-900">Opening the companion… If it does not open, enter pairing code <strong className="ml-1 font-mono tracking-wider">{pairingCode}</strong>.</div>}{companionMessage && <p className="mt-2 text-[9px] text-amber-700">{companionMessage}</p>}</section>
      <section><div className="mb-2 flex items-center justify-between"><span className="text-[9px] font-semibold uppercase tracking-[.13em] text-zinc-400">Repositories on this machine</span><span className="text-[9px] text-zinc-400">No terminal required</span></div><div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 px-4">{projects.map((project) => <div key={project.id} className="flex items-center gap-3 py-3"><FolderGit2 size={15} className="text-zinc-400" /><div className="min-w-0 flex-1"><div className="text-[10px] font-semibold">{project.name}</div><div className="mt-1 truncate font-mono text-[9px] text-zinc-400">{settings.mappings[project.id] ?? `${project.repositoryOwner}/${project.repositoryName}`}</div></div>{settings.mappings[project.id] ? <span className="flex items-center gap-1 text-[9px] font-medium text-emerald-700"><Check size={11} /> Ready</span> : <button onClick={() => void connectProject(project)} className="rounded-lg border border-zinc-200 px-2.5 py-1.5 text-[9px] font-medium hover:bg-zinc-50">Clone or choose folder</button>}</div>)}</div></section>
    </div><div className="flex justify-end border-t border-zinc-100 px-6 py-4"><button onClick={onClose} className="rounded-xl bg-zinc-950 px-4 py-2.5 text-[10px] font-medium text-white">Done</button></div>
  </Modal>;
}

function ShareModal({ project, onClose, toast }: { project: ProjectItem; onClose: () => void; toast: (message: string) => void }) {
  const invite = `${window.location.origin}/join/${project.id}`;
  return <Modal onClose={onClose} width="max-w-md"><ModalHeader icon={<UsersRound size={16} />} title={`Invite to ${project.name}`} description="Members can submit requests after repository access is verified." onClose={onClose} />
    <div className="p-5 sm:p-6"><Field label="Invite link"><div className="flex gap-2"><input readOnly value={invite} className={cx(fieldClass, "font-mono text-[9px]")} /><button onClick={() => { void navigator.clipboard?.writeText(invite); toast("Invite link copied."); }} className="grid size-10 shrink-0 place-items-center rounded-xl border border-zinc-200 hover:bg-zinc-50"><Copy size={14} /></button></div></Field><div className="mt-5 divide-y divide-zinc-100 rounded-xl border border-zinc-200 px-3">{project.members.map((member) => <div key={member.id} className="flex items-center gap-2.5 py-2.5"><Avatar user={member} size="xs" online={member.online} /><div><div className="text-[10px] font-medium">{member.name}</div><div className="text-[8px] text-zinc-400">@{member.username}</div></div><span className="ml-auto text-[9px] text-zinc-400">{member.id === "alice" ? "Owner" : "Member"}</span></div>)}</div></div>
  </Modal>;
}

function JoinProjectStatus({ state, onClose, onRetry }: { state: JoinState; onClose: () => void; onRetry: () => void }) {
  const joining = state.status === "joining";
  const readOnly = state.status === "read-only";
  return <Modal onClose={joining ? () => undefined : onClose} width="max-w-md">
    <div className="p-7 text-center">
      <div className={cx("mx-auto grid size-11 place-items-center rounded-xl", joining ? "bg-zinc-100 text-zinc-600" : readOnly ? "bg-amber-50 text-amber-700" : "bg-red-50 text-red-600")}>{joining ? <LoaderCircle size={19} className="animate-spin" /> : readOnly ? <Eye size={19} /> : <AlertTriangle size={19} />}</div>
      <h3 className="mt-4 text-[16px] font-semibold tracking-tight">{joining ? "Verifying repository access" : readOnly ? "Joined with read-only access" : "Couldn’t join this project"}</h3>
      <p className="mx-auto mt-2 max-w-sm text-[11px] leading-5 text-zinc-500">{joining ? "Mutex is checking that your GitHub account has access to this repository." : state.message ?? "Mutex could not verify access to the project repository."}</p>
      {state.status === "error" && <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-left text-[10px] leading-4 text-amber-900"><strong>Already a collaborator?</strong> Reconnect GitHub so Mutex receives the repository permission, then retry this invite. For an organization repository, you may also need to authorize the organization’s SSO.</div>}
      {state.status === "error" && <div className="mt-5 flex flex-wrap justify-center gap-2"><button onClick={onClose} className="rounded-xl border border-zinc-200 px-4 py-2.5 text-[10px] font-medium text-zinc-600">Back to projects</button><button onClick={onRetry} className="rounded-xl border border-zinc-200 px-4 py-2.5 text-[10px] font-medium text-zinc-700"><RefreshCw size={12} className="mr-1.5 inline" />Try again</button><button onClick={beginGithubLogin} className="flex items-center gap-2 rounded-xl bg-zinc-950 px-4 py-2.5 text-[10px] font-medium text-white"><Github size={13} /> Reconnect GitHub</button></div>}
      {readOnly && <div className="mt-5 flex justify-center gap-2"><button onClick={beginGithubLogin} className="flex items-center gap-2 rounded-xl border border-zinc-200 px-4 py-2.5 text-[10px] font-medium text-zinc-700"><Github size={13} /> Reconnect GitHub</button><button onClick={onClose} className="rounded-xl bg-zinc-950 px-4 py-2.5 text-[10px] font-medium text-white">Continue read-only</button></div>}
    </div>
  </Modal>;
}

function CompanionConnectStatus({ state, onClose }: { state: PairingState; onClose: () => void }) {
  const code = state.code;
  return <Modal onClose={state.status === "pairing" ? () => undefined : onClose} width="max-w-md"><div className="p-7 text-center"><div className={cx("mx-auto grid size-11 place-items-center rounded-xl", state.status === "error" ? "bg-red-50 text-red-600" : "bg-zinc-100 text-zinc-700")}>{state.status === "pairing" ? <LoaderCircle size={19} className="animate-spin" /> : state.status === "ready" ? <Laptop2 size={19} /> : <AlertTriangle size={19} />}</div><h3 className="mt-4 text-[16px] font-semibold tracking-tight">{state.status === "pairing" ? "Creating a secure connection" : state.status === "ready" ? "Finish in Mutex Companion" : "Companion pairing failed"}</h3><p className="mx-auto mt-2 max-w-sm text-[11px] leading-5 text-zinc-500">{state.status === "pairing" ? "This only takes a moment." : state.status === "ready" ? "The desktop app should open automatically. If it does not, enter the code below in the companion." : state.message}</p>{code && <button onClick={() => void navigator.clipboard?.writeText(code)} className="mx-auto mt-5 flex items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 font-mono text-[14px] font-semibold tracking-[.18em]"><Copy size={13} className="text-zinc-400" />{code}</button>}<button onClick={onClose} className="mt-5 rounded-xl bg-zinc-950 px-4 py-2.5 text-[10px] font-medium text-white">Back to Mutex</button></div></Modal>;
}

function CancelModal({ task, onClose, onConfirm }: { task: Task; onClose: () => void; onConfirm: () => void }) {
  const pending = ["QUEUED", "WAITING_FOR_REQUESTER", "REMOTE_DIVERGED"].includes(task.status);
  return <Modal onClose={onClose} width="max-w-md"><ModalHeader icon={pending ? <Trash2 size={15} /> : <Square size={14} fill="currentColor" />} title={pending ? `Delete Request #${task.number}?` : `Cancel Request #${task.number}?`} description={pending ? "This request will be removed from the execution queue." : "The developer process will stop and release the project execution lock."} onClose={onClose} /><div className="p-6"><div className="rounded-xl bg-zinc-50 p-3 text-[10px] leading-4 text-zinc-600">{pending ? "The request will be retained as cancelled in project history for attribution and auditing. It will not execute and no repository files will be changed." : "Local tracked changes will be discarded and the executor’s repository will reset to the current remote branch. Untracked files are preserved."}</div><div className="mt-5 flex justify-end gap-2"><button onClick={onClose} className="rounded-xl px-4 py-2.5 text-[10px] font-medium text-zinc-500">{pending ? "Keep request" : "Keep running"}</button><button onClick={onConfirm} className="rounded-xl bg-red-600 px-4 py-2.5 text-[10px] font-medium text-white">{pending ? "Delete request" : "Cancel task"}</button></div></div></Modal>;
}

function RollbackModal({ task, allTasks, socket, serverMode, onClose, onConfirm }: { task: Task; allTasks: Task[]; socket: AppSocket | null; serverMode: "connecting" | "live" | "demo"; onClose: () => void; onConfirm: (discarded: Task[]) => void }) {
  const [confirmation, setConfirmation] = useState("");
  const [working, setWorking] = useState(false);
  const discarded = allTasks.filter((item) => item.status === "COMMITTED" && item.number >= task.number).sort((a, b) => a.number - b.number);
  const active = allTasks.find((item) => activeStatuses.includes(item.status));
  const run = async () => {
    if (confirmation !== "ROLLBACK") return; setWorking(true);
    if (serverMode === "live") await api(`/api/tasks/${task.id}/rollback`, { method: "POST", body: JSON.stringify({ projectId: task.projectId, confirmation: "ROLLBACK" }) });
    else socket?.emit("ROLLBACK_TASK", { projectId: task.projectId, taskId: task.id, confirmation: "ROLLBACK" });
    window.setTimeout(() => { setWorking(false); onConfirm(discarded); }, serverMode === "demo" ? 750 : 150);
  };
  return <Modal onClose={onClose} width="max-w-lg"><div className="border-b border-red-100 bg-red-50/70 px-5 py-5 sm:px-6"><div className="flex items-start gap-3"><div className="grid size-10 shrink-0 place-items-center rounded-xl bg-red-100 text-red-700"><AlertTriangle size={19} /></div><div><h3 className="text-[16px] font-semibold tracking-tight text-red-950">Rollback to before Request #{task.number}?</h3><p className="mt-1 text-[10px] leading-4 text-red-800">This is destructive and rewrites remote Git history.</p></div><button onClick={onClose} className="ml-auto rounded-lg p-1.5 text-red-500 hover:bg-red-100"><X size={17} /></button></div></div>
    <div className="p-5 sm:p-6"><p className="text-[11px] leading-5 text-zinc-600">This will discard <strong className="text-zinc-900">{discarded.length} committed task{discarded.length === 1 ? "" : "s"}</strong> from the configured branch:</p><div className="mt-3 max-h-40 divide-y divide-zinc-100 overflow-y-auto rounded-xl border border-zinc-200 px-3">{discarded.map((item) => <div key={item.id} className="flex items-center gap-3 py-2.5"><span className="font-mono text-[9px] font-medium text-zinc-400">#{item.number}</span><span className="min-w-0 flex-1 truncate text-[10px] text-zinc-700">{item.rootMessage?.body}</span><span className="font-mono text-[8px] text-zinc-400">{shortSha(item.commitSha)}</span></div>)}</div>
      {active && <div className="mt-3 flex gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-[9px] leading-4 text-red-900"><Square size={12} className="mt-0.5 shrink-0" fill="currentColor" /> Currently running Request #{active.number} will also be cancelled. Its local tracked changes will be discarded.</div>}
      <div className="mt-4 text-[10px] leading-5 text-zinc-600"><strong>Remote Git history will be rewritten</strong> with <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[9px]">--force-with-lease</code> using your local Git credential. Every connected companion will then synchronize.</div>
      <Field label='Type "ROLLBACK" to confirm'><input autoFocus value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="ROLLBACK" className={cx(fieldClass, "mt-4 border-red-200 focus:border-red-500 focus:ring-red-50")} /></Field>
      <div className="mt-5 flex justify-end gap-2"><button disabled={working} onClick={onClose} className="rounded-xl px-4 py-2.5 text-[10px] font-medium text-zinc-500">Cancel</button><button disabled={confirmation !== "ROLLBACK" || working} onClick={() => void run()} className="flex items-center gap-2 rounded-xl bg-red-600 px-4 py-2.5 text-[10px] font-medium text-white disabled:cursor-not-allowed disabled:bg-red-200">{working ? <LoaderCircle size={12} className="animate-spin" /> : <RotateCcw size={12} />}Rewrite remote history</button></div>
    </div>
  </Modal>;
}
