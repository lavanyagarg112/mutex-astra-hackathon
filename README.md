# Mutex

Mutex is a collaborative request queue for AI-assisted software development. Teams submit changes in the browser, while a desktop Companion performs the actual agent, filesystem, process, and Git work on the requester's computer.

The configured remote Git branch is always canonical. Mutex allows one repository-writing task per project, keeps queue order as explicit application state, and records every important scheduler and Git transition.

## How it works

1. A user signs in with GitHub and authorises the desktop Companion.
2. They create a project from a repository they can write to.
3. Each member clones or maps that project in their own Companion.
4. A request runs on the requester's computer using their local Git identity and credential.
5. The Companion synchronises to the remote branch, runs the agent, validates the result, creates one commit, and pushes it.
6. Mutex accepts the commit automatically, stores its diff, and synchronises every online member.

Small, compatible requests can be combined into an amendable active task. Conflicting requests and low-confidence matches remain separate. User-to-user project chat is kept outside the developer agent's context.

## Core guarantees

- One active mutating task per project; separate projects may run concurrently.
- Pending tasks use `queuePriority DESC, queueSequence ASC`, not message time.
- An offline requester does not block other executable work.
- Refinements have priority over normal queued requests.
- Remote divergence never overwrites upstream work; the task is reset and requeued.
- Git credentials remain on the member's computer.
- Completed tasks are accepted automatically and retain a centrally stored diff.
- Rollback is an explicit, confirmed `--force-with-lease` history rewrite.

## Repository layout

```text
apps/
  web/         React, Vite, and Tailwind interface
  server/      Express, Socket.IO, Prisma, scheduler, and coordinator
  companion/   Electron desktop Companion
  daemon/      Headless/legacy Companion CLI
packages/
  shared/      Zod schemas, domain types, and WebSocket contracts
```

## Run locally

### Requirements

- Node.js 20 or newer
- npm
- Git
- PostgreSQL 14 or newer

### 1. Install and configure

```bash
npm install
cp .env.example apps/server/.env
cp .env.example apps/web/.env
```

Edit `apps/server/.env` and add your GitHub OAuth credentials. Generate `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY` with:

```bash
openssl rand -base64 32
```

Use these values for a local GitHub OAuth App:

```text
Homepage URL:               http://localhost:5173
Authorization callback URL: http://localhost:4100/api/auth/github/callback
```

Then set:

```dotenv
GITHUB_CLIENT_ID=your-client-id
GITHUB_CLIENT_SECRET=your-client-secret
GITHUB_CALLBACK_URL=http://localhost:4100/api/auth/github/callback
GITHUB_OAUTH_SCOPE="read:user repo"
```

### 2. Prepare PostgreSQL

On macOS with Homebrew:

```bash
brew services start postgresql@14
createdb relaycode
npm run db:generate && npm run db:migrate
```

If `relaycode` already exists, skip `createdb relaycode`. Update `DATABASE_URL` in `apps/server/.env` if your PostgreSQL username, password, host, or database name differs.

### 3. Start Mutex

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The API runs at `http://localhost:4100`; its health check is `GET /health`.

### 4. Start the Companion during development

In a second terminal:

```bash
npm run dev -w @relaycode/companion
```

In the browser, open **Authorisation**, connect the Companion, then create a project. Open the project and choose **Clone repository** or **Use existing folder**. Contributors clone the selected project repository—not this Mutex source repository.

The Companion stores its pairing data and repository mappings locally. No database edits or manual pairing-code entry are required.

## Project setup

Project creation requires:

- GitHub write access to the selected repository.
- A previously authorised Companion.
- A branch to use as the canonical source of truth.

Mutex inspects the repository and proposes install, frontend, backend, and validation commands. Project owners can change them or run **Infer again** from **Project settings → Commands**. The preview starts the inferred local processes, reports their actual ports and URLs, and releases ports when those processes stop.

Configure the shared OpenAI key once under **Project settings → Agent**. The server stores it centrally and exposes only whether it is configured. It is never written to activity logs or returned to browser clients.

Validation is required before a normal task can push. Repository-initialisation tasks are allowed to create or repair the validation command first. When a command fails, the Companion retries it once; an agent task can then use the failure output to repair the implementation and validate again.

## Git lifecycle

Before editing, the Companion performs the equivalent of:

```text
git fetch origin
git checkout <branch>
git reset --hard origin/<branch>
```

Untracked files such as local `.env` files are preserved. Before committing, Mutex fetches again and verifies that the remote branch still matches the recorded base commit. If it changed, tracked work is discarded, the Companion synchronises to the new head, and the request is requeued.

Rollback targets the selected task's base commit, cancels active work, and pushes with `--force-with-lease`. Branch protection may reject this operation, so the rollback demo needs a branch that permits history rewriting. Discarded task records remain in PostgreSQL.

## Deploy to Render

The included `render.yaml` creates one Docker web service and one PostgreSQL database. The production server serves the built browser app from the same origin.

1. Push this repository to GitHub.
2. In Render, choose **New → Blueprint** and select the repository.
3. Fill the Blueprint environment values below and deploy.
4. Update the GitHub OAuth App to use the deployed URL.

| Variable | Value |
| --- | --- |
| `PUBLIC_URL` | `https://YOUR-SERVICE.onrender.com` |
| `WEB_ORIGIN` | `https://YOUR-SERVICE.onrender.com` |
| `GITHUB_CLIENT_ID` | GitHub OAuth client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth client secret |
| `GITHUB_CALLBACK_URL` | `https://YOUR-SERVICE.onrender.com/api/auth/github/callback` |
| `COMPANION_RELEASE_URL` | `https://github.com/lavanyagarg112/mutex-public/releases/tag/v1` |

Render supplies `DATABASE_URL` and generates both server secrets. Keep `ALLOW_DEMO_AUTH=false` in production. Set the GitHub OAuth App homepage to the deployed root URL and its callback to the exact URL shown above.

## Publish the Companion

The **Companion installers** GitHub Actions workflow builds macOS, Windows, and Linux packages. Run it manually or push a version tag:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The current installers are available from the [Mutex Companion v1 release](https://github.com/lavanyagarg112/mutex-public/releases/tag/v1). Set `COMPANION_RELEASE_URL` to that page so Mutex displays one **Download Companion** button that works for every operating system.

Local packaging commands are also available:

```bash
npm run package:mac -w @relaycode/companion
npm run package:windows -w @relaycode/companion
npm run package:linux -w @relaycode/companion
```

Unsigned development builds may trigger operating-system warnings. Public distribution should use the appropriate Apple and Windows code-signing certificates.

## Useful commands

```bash
npm run dev                 # browser + server
npm run build               # production build
npm run typecheck           # TypeScript checks
npm test                    # unit and orchestration tests
npm run db:generate         # generate Prisma Client
npm run db:migrate          # apply checked-in migrations
npm run db:seed             # create local demo users only
```

## Demo flow

1. Alice and Bob sign in, authorise their Companions, and map the same project.
2. Alice requests a dark-mode toggle.
3. While Alice's task is amendable, Bob replies that it should live in Settings; the refinement joins the active task.
4. Alice's Companion validates and pushes one combined commit. Mutex displays the diff and synchronises both machines.
5. Bob refines the completed task. The new refinement runs before older normal queued work and executes on Bob's computer.
6. Alice rolls back an earlier task. Mutex lists the commits that will disappear, cancels active work, force-pushes with Alice's credential, and synchronises the team.

## MVP boundary

The current lock and socket registry targets one application-server instance, which is appropriate for the hackathon deployment. Horizontal scaling requires a shared Socket.IO adapter and a distributed project lock. Local preview URLs are not tunneled; if a page cannot be embedded, Mutex provides an external **Open** link.
