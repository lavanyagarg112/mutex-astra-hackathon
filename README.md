# Relaycode

Relaycode is a collaborative request queue for AI-assisted software development. The browser coordinates people, explicit queue order, task state, diffs, and activity. A small companion runs on each developer's computer and is the only component allowed to touch their repository, use their Git credential, or run the developer agent.

This repository contains a working hackathon MVP—not only a prototype screen. It includes the web app, real-time server, PostgreSQL schema and seed data, deterministic scheduler, local companion, real Git synchronization/commit/push/rollback operations, and an OpenAI/command/demo agent abstraction.

## What the demo proves

- One mutating task per project; different projects can run concurrently.
- Pending work is sorted by `queuePriority DESC, queueSequence ASC`, never by message time.
- An offline requester is marked waiting and does not block other executable work.
- Explicit or confidently classified refinements amend a still-amendable active task without restarting it.
- Later refinements become priority tasks and move above normal work.
- The requesting user's companion performs hard synchronization, agent work, validation, commit, and push with that user's local Git identity and credential.
- A second fetch immediately before commit detects remote divergence, resets safely, and requeues the task.
- Successful commits are accepted automatically, their centralized diffs appear in the UI, and all online companions synchronize.
- Rollback is a confirmed, locked, force-with-lease history rewrite that retains discarded task records.
- Pause, resume, cancel, member presence, project settings, user mappings, process status, and the activity terminal are wired end to end.

## Architecture

```text
apps/web       React + Vite + Tailwind operator workspace
apps/server    Express + Socket.IO + Prisma scheduler/coordinator
apps/daemon    Local Node CLI, Git/process access, agent providers
packages/shared  Zod contracts and typed WebSocket payloads
```

The remote configured branch is canonical. The server never performs hidden Git changes and the language model never controls queue state. Task transitions are validated on the server; repository mutations are explicit commands in the assigned user's companion.

## Quick start

Requirements: Node.js 20+, npm, Git, and PostgreSQL 14+. Docker is optional. GitHub login is optional for a local demo and required for a deployed workspace.

1. Install dependencies and create local environment files.

   ```bash
   npm install
   cp .env.example apps/server/.env
   cp .env.example apps/web/.env
   ```

2. Start PostgreSQL, generate the Prisma client, apply the migration, and seed the two-person demo. On a Mac with Homebrew PostgreSQL:

   ```bash
   brew services start postgresql@14
   createdb relaycode 2>/dev/null || true
   npm run db:generate && npm run db:migrate && npm run db:seed
   ```

   If you do have Docker, the equivalent database startup is:

   ```bash
   docker compose up -d postgres
   npm run db:generate && npm run db:migrate && npm run db:seed
   ```

3. Start the browser and coordination server.

   ```bash
   npm run dev
   ```

4. Open [http://localhost:5173](http://localhost:5173). For the local demo, use the seeded usernames `alice` or `bob`. For real repositories, add GitHub OAuth values below and choose **Continue with GitHub**.

The server listens on `http://localhost:4100`. `GET /health` is the readiness check.

## Connect the desktop companion

For normal use, contributors do **not** clone this Relaycode repository or configure a daemon in a terminal. Publish the companion once, then each contributor:

1. Signs in to Relaycode with GitHub.
2. Opens **Personal settings**, downloads Relaycode Companion for macOS, Windows, or Linux, and installs it.
3. Returns to Relaycode and chooses **Connect companion**. The browser opens the desktop app and passes a one-time pairing code.
4. In the desktop app, chooses **Clone repository** or **Use existing folder** for each project.

The Companion keeps its pairing token and GitHub credential only in that operating-system user account. It clones the project repository itself; it never asks the user to clone Relaycode. Build each native distributable with:

```bash
npm run package:mac -w @relaycode/companion
npm run package:windows -w @relaycode/companion
npm run package:linux -w @relaycode/companion
```

The GitHub Actions workflow **Companion installers** builds all three operating-system packages. Run it manually or push a version tag, download its artifacts, and attach them to a GitHub Release. macOS produces a universal DMG/ZIP, Windows produces an NSIS installer/ZIP, and Linux produces AppImage/DEB packages.

For local development, run `npm run dev -w @relaycode/companion`. On macOS this creates and launches an unpacked `Relaycode Companion.app` with the real `relaycode://` registration; launching the generic Electron binary cannot receive website deep links correctly.

When an owner creates a project, Relaycode inspects the configured GitHub branch and pre-fills the install, frontend, backend, and validation commands from repository conventions. Owners can review or edit every value under **Project settings → Commands**, or use **Infer again** after the repository changes. With the shared OpenAI key configured, the project agent interprets manifests, README instructions, CI workflows, Makefiles, Docker Compose, environment examples, and workspace configuration, then selects only commands grounded in those files; unsafe or ungrounded suggestions are rejected. Detection supports common npm/pnpm/yarn/Bun monorepos, Python/FastAPI/Django/pytest projects, Go, and Rust, and gracefully falls back to deterministic detection.

The preview Play control runs the inferred install command to completion, retries it once on failure, and starts the backend and frontend only after installation succeeds. The companion reports the actual local development URL to the signed-in user's browser, which embeds it in the preview panel and always provides an external **Open** link for sites that disallow iframes.

Required validation commands retry once immediately after a non-zero exit. Relaycode advances only if the retry succeeds; if it also fails after agent work, the existing repair loop receives the failure output, updates the implementation, and validates again before any push.

Upload the installers to a release host and set `COMPANION_DOWNLOAD_URL_MAC`, `COMPANION_DOWNLOAD_URL_WINDOWS`, and `COMPANION_DOWNLOAD_URL_LINUX` to their public URLs. Personal Settings detects the visitor’s operating system while keeping all three downloads available. The legacy CLI flow below remains useful for local development and CI.

### Legacy CLI companion

The companion stores its identity and project mappings locally in `~/.relaycode/config.json` with owner-only permissions. Git credentials use your existing local Git credential helper and are never sent to the server. First configure the companion identity:

```bash
npm run cli -w @relaycode/daemon -- configure \
  --server-url http://localhost:4100 \
  --user-id alice \
  --token alice-daemon-token
```

Then configure a project mapping using the seeded project ID:

```bash
npm run cli -w @relaycode/daemon -- configure project project-alpha \
  --path /absolute/path/to/your/repository \
  --remote https://github.com/your-org/your-repository.git
```

Then start Alice's companion:

```bash
RELAYCODE_USER_ID=alice \
RELAYCODE_DAEMON_TOKEN=alice-daemon-token \
npm run dev -w @relaycode/daemon
```

In Relaycode, open **Project settings → Agent**. A project owner enters the shared OpenAI key once and selects the developer model. The server stores the credential but never returns it to browsers or activity feeds; it is delivered only to the daemon assigned the current task. Git credentials remain local to each developer.

Run Bob's companion in another terminal with `bob` and `bob-daemon-token`. Each user needs their own repository copy and local mapping. On first connection or reconnection, the companion synchronizes before it becomes eligible to execute tasks.

### Agent providers

The companion selects the first configured provider:

1. A configured command provider runs your installed coding-agent command in the bound repository and sends the structured task on standard input.
2. A shared OpenAI credential configured in Project settings uses the Responses API provider on the assigned local companion. Local `OPENAI_API_KEY` and `OPENAI_MODEL` values remain optional headless/CI fallbacks.
3. Demo provider: makes a deterministic, visible repository change so the complete Git workflow can be demonstrated without an API account.

For an external coding CLI, for example:

```bash
npm run cli -w @relaycode/daemon -- configure --agent-provider command --agent-command 'your-agent-command'
```

Never put an OpenAI or GitHub token in a request or project activity. Use the dedicated Project settings credential field; normal project responses expose only a configured/not-configured indicator, and activity metadata is sanitized.

## Git safety contract

Before each task the companion performs the equivalent of:

```text
git fetch origin
git checkout <branch>
git reset --hard origin/<branch>
```

It intentionally does not run `git clean`; pre-existing untracked files such as `.env` remain untouched and are excluded from task commits. Immediately before commit it fetches again and compares `origin/<branch>` with the recorded base SHA. A mismatch produces `REMOTE_DIVERGED`, discards tracked work, synchronizes to the new head, and requeues the request without overwriting the remote.

Rollback targets the selected task's `baseCommitSha`. It acquires the project rollback lock, cancels active work, fetches, resets, and uses:

```text
git push --force-with-lease=refs/heads/<branch>:<observed-head> origin <branch>
```

Protected branches may reject this operation; the application reports that failure and keeps its task records. For the rollback demo, use a branch whose protection rules permit history rewriting.

## Deploy to Render

Relaycode is deployable as one Docker web service plus PostgreSQL; the production server serves the built web app from the same origin. `render.yaml` provisions both.

1. Push this repository to a GitHub repository you control and create a Render Blueprint from it.
2. In GitHub, create an OAuth App. Its authorization callback must be exactly:

   ```text
   https://YOUR-RELAYCODE-DOMAIN/api/auth/github/callback
   ```

   Add `read:user repo` as the OAuth scope (`GITHUB_OAUTH_SCOPE`). `repo` is needed to list private repositories and verify write access.
3. In Render, set the Blueprint's `PUBLIC_URL` and `WEB_ORIGIN` to `https://YOUR-RELAYCODE-DOMAIN`, then add the GitHub client ID, client secret, callback URL, and scope. Keep `ALLOW_DEMO_AUTH=false`.
4. Run **Companion installers** in GitHub Actions, publish its macOS, Windows, and Linux artifacts, then set the three `COMPANION_DOWNLOAD_URL_*` values. People can now sign in, join only repositories their GitHub account can write to, and pair their local Companion without a terminal.

There is no universal “Sign in with ChatGPT” authentication flow used here. GitHub OAuth is the right identity source because it also provides the repository authorization check Relaycode needs.

## Useful commands

```bash
npm run dev                 # web + server
npm run dev:all             # web + server + one companion
npm run build               # all workspaces
npm run typecheck           # TypeScript checks
npm test                    # scheduler/Git/unit tests
npm run package:mac -w @relaycode/companion # macOS desktop companion
npm run package:windows -w @relaycode/companion # Windows desktop companion
npm run package:linux -w @relaycode/companion # Linux desktop companion
npm run db:generate         # Prisma client
npm run db:migrate          # deploy checked-in SQL migration
npm run db:seed             # reset/upsert demo records
npm run cli -w @relaycode/daemon -- list
```

## Demo script

1. Sign in as Alice in one browser and Bob in another, with both companions online.
2. Alice submits “Add a dark-mode toggle.” Her task synchronizes and starts locally.
3. While the activity feed reports it as amendable, Bob explicitly replies “Put the toggle inside Settings.” The same task and executor remain active.
4. After validation, one commit is pushed with Alice's local Git identity. The diff is persisted centrally, accepted automatically, and both companions synchronize.
5. Queue a normal task, then refine the completed task as Bob: “Respect the user's system theme by default.” The new priority refinement visibly moves above the older normal request and runs on Bob's machine.
6. Choose Rollback on the earlier task. The confirmation lists every task that will disappear and warns that active work will be cancelled. Confirm by entering `ROLLBACK`; Alice's companion performs the force-with-lease operation and the team synchronizes.

## Security and MVP boundaries

- GitHub OAuth is used for production sign-in and repository-access validation. Username sign-in is available only when `ALLOW_DEMO_AUTH=true`, which the production blueprint disables.
- Project membership and write permission are checked for every server action and WebSocket command.
- Daemons authenticate separately, and tasks are dispatched only to the requesting user's socket.
- Agent output and messages are rendered as text, not HTML. Sensitive settings are redacted from browser payloads and activity metadata.
- The optional local preview uses localhost URLs only. If iframe policy blocks embedding, the UI provides an explicit Open Preview link; no tunneling service is included.
- The in-process socket/lock registry is appropriate for one hackathon server instance. Production horizontal scaling requires a shared Socket.IO adapter and a PostgreSQL advisory/distributed lock.

## Environment

See [.env.example](./.env.example) and copy it into `apps/server/.env` and `apps/web/.env` as shown above. The core settings are `DATABASE_URL`, `PORT`, `WEB_ORIGIN`, `VITE_API_URL`, `DEMO_REPOSITORY_URL`, `DEMO_BRANCH`, `RELAYCODE_SERVER_URL`, `RELAYCODE_USER_ID`, and `RELAYCODE_DAEMON_TOKEN`. The shared OpenAI credential is normally configured once in Project settings; environment variables remain an optional headless fallback.
