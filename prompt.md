Build a hackathon-ready full-stack application for collaborative multi-user
AI-assisted software development.

Do not only produce a design document. Implement the working MVP.

PRODUCT CONCEPT

The application is a browser-based collaborative request queue for a shared
software repository.

Multiple developers belong to a project. They submit natural-language coding
requests into a shared interface.

Exactly one developer-agent task may modify a project's repository at any
time.

The remote Git repository and configured branch are ALWAYS the canonical
source of truth.

The AI developer does NOT execute in a cloud sandbox.

Each human user runs a small local companion daemon/CLI on their own computer.
When that user's request reaches the front of the queue, the developer agent
executes against THAT USER'S local repository copy.

The browser application coordinates users, queue state and agent state. The
local daemon performs filesystem, shell, Git and local process operations.

TECH STACK

Use a TypeScript monorepo.

Suggested structure:

apps/
  web/
  server/
  daemon/

packages/
  shared/

Frontend:
- React
- TypeScript
- Tailwind CSS
- clean component system such as shadcn/ui

Backend:
- Node.js
- TypeScript
- Fastify or Express
- Socket.IO or equivalent WebSocket layer

Database:
- PostgreSQL
- Prisma ORM

Local daemon:
- Node.js + TypeScript CLI
- WebSocket connection to backend
- local filesystem access
- child_process execution
- Git operations

Shared:
- Zod schemas
- shared WebSocket event types
- task/project/user types

The project must be easy to run locally for a hackathon.

Provide:
- README
- .env.example
- database schema
- migrations
- seed script
- startup commands

==================================================
CORE SYSTEM INVARIANTS
==================================================

1. Remote Git repository is always source of truth.

2. Only ONE task per project may be executing and mutating code at once.

3. Different projects may execute concurrently.

4. Every task executes on the machine of the user who requested that task.

5. Git operations for a task use the requesting user's Git credential.

6. Git operations performed by another user, including rollback, use that
   user's own credential.

7. Before a local machine executes a task, synchronize tracked files exactly
   to the current configured remote branch.

8. Do not trust local tracked-file changes.

9. The queue is NOT visually ordered by message timestamp.

10. Queue order is explicit application state.

11. Refinement requests have higher queue priority than normal requests.

12. Completed tasks are automatically accepted. There is no approval gate.

13. After completion, users may either:
    - refine the task
    - rollback the task

==================================================
LOCAL COMPANION DAEMON
==================================================

A pure browser cannot safely control arbitrary local repositories or launch
processes, therefore create a local daemon.

The daemon must:

- authenticate/connect to the web backend
- identify which user it belongs to
- maintain local project bindings:
    projectId -> absolute local repository path
- report online/offline status
- perform Git fetch/reset/push operations
- execute developer-agent operations
- run shell/test/build commands
- optionally launch local development servers
- stream structured status events to the backend

DO NOT send GitHub tokens into activity logs.

Prefer keeping Git credentials locally.

Create a simple local configuration flow.

Example:

project abc123
local path:
  /Users/alice/code/project

When opening a project without a local mapping, ask the user to select or
configure their local repository path.

Validate that the configured folder points to the expected Git repository.

==================================================
GIT SYNCHRONIZATION
==================================================

Before executing a task:

1. git fetch origin
2. identify current origin/<configured branch>
3. reset tracked files to that commit
4. record this SHA as task.baseCommitSha

Use semantics equivalent to:

git fetch origin
git checkout <branch>
git reset --hard origin/<branch>

Do not blindly delete all untracked files because users may have local .env
files or other machine-specific files.

Before pushing:

1. git fetch origin again
2. compare origin/<branch> to task.baseCommitSha

If the remote changed externally while the agent was working:

- DO NOT overwrite the remote
- mark task as REMOTE_DIVERGED / retryable failure
- discard local tracked changes
- sync to new remote HEAD
- requeue the request

If remote has not changed:

- create one commit for the completed task
- commit author must correspond to requesting user's Git identity
- push using requesting user's Git credential

After successful push:

- save task.commitSha
- mark task COMMITTED
- automatic acceptance is immediate
- broadcast SYNC_PROJECT to all connected project members

Every connected user's daemon should:

git fetch origin
git reset --hard origin/<branch>

Report its resulting commit SHA.

Offline clients must NOT block task progression.

When an offline client reconnects, force it to synchronize before it may
execute a task.

==================================================
TASK QUEUE
==================================================

A project has exactly one active task.

Pending tasks have:

- queuePriority
- queueSequence

Sort pending tasks by:

queuePriority DESC
queueSequence ASC

Priorities:

REFINEMENT = 100
NORMAL = 0

createdAt must NOT determine execution ordering.

Store createdAt separately for audit purposes.

The UI must render the task list in actual queue execution order, not
chronological chat order.

==================================================
REQUESTS
==================================================

A normal user message that asks for a code change creates a NORMAL task.

Fields include:

- requestedBy user
- root message
- queue position
- state
- executor user
- Git base SHA
- resulting commit SHA

The executor is normally the requesting user.

Before accepting the request, verify:

- user is authenticated
- user is authorized for the project
- user's GitHub identity has access to the configured repository
- for write operations require appropriate repository write permission
- user has a connected local daemon, or mark the task WAITING_FOR_REQUESTER
- project has valid agent configuration

==================================================
COORDINATOR AGENT
==================================================

Use a lightweight coordinator model separately from the developer agent.

Its purpose is NOT to modify files.

It classifies an incoming request relative to the currently active task.

It should determine whether the incoming request:

A. is an in-flight refinement of the active task
B. is an independent request

The active developer task also reports:

amendable: boolean

Only merge a refinement into the active task when:

- coordinator determines it logically belongs to the active task
AND
- activeTask.amendable === true

Do NOT restart the developer agent.

Send the running developer agent a structured task-amendment event.

If the request is a refinement but activeTask.amendable is false, create a new
high-priority REFINEMENT task.

If classifier confidence is low, default to creating a separate queued task.
Do not risk incorrectly mutating an active task.

Allow users to explicitly submit a message as a refinement/reply. Explicit
user intent overrides model classification.

==================================================
IN-FLIGHT REFINEMENTS
==================================================

Example:

Alice:
"Add Google authentication."

Task #14 begins on Alice's computer.

Bob:
"Also redirect to /dashboard after login."

If Task #14 is amendable:

- store Bob's message
- attach it to Task #14 as IN_FLIGHT_REFINEMENT
- notify Alice's running developer-agent process
- Task #14 remains one task
- executor remains Alice
- final Git result is still one commit

Render the refinement as a reply to the original request.

==================================================
POST-COMMIT REFINEMENTS
==================================================

If a task is already committed, any later refinement becomes a NEW task.

Example queue:

ACTIVE:
#15 Build profile screen

QUEUED:
#16 Add logout
#17 Add settings

Bob refines completed #14.

Create #18:

type = REFINEMENT
parentTaskId = #14
requestedBy = Bob

Queue becomes:

#15 active
#18 next
#16
#17

The refinement takes priority immediately AFTER the currently active task.

Visually show #18 as:

"Refinement of Request #14"

It should look like a reply/link to the original request.

Clicking the parent reference should scroll to/highlight the original task.

Despite being created later, the refinement must visually move above normal
queued requests because UI order follows queue order, not timestamp.

==================================================
AUTO ACCEPTANCE
==================================================

There is no manual review blocking the queue.

Once a task:

- completes
- commits
- pushes successfully

it becomes:

COMMITTED / AUTO ACCEPTED

Metadata should display:

Requested by:
Alice

Executed by:
Alice

Commit:
abc123

Accepted by:
Automatic acceptance

Then proceed with synchronization and the next executable task.

==================================================
DIFF DISPLAY
==================================================

After successful task completion, show a code diff attached to the task card.

Compute the diff between:

task.baseCommitSha
and
task.commitSha

Store enough diff information centrally so the UI does not depend on one
specific user's machine staying online.

Display:

- changed file list
- additions/deletions
- expandable unified diff
- commit SHA
- base SHA

Completed task cards should have:

[View diff]
[Refine]
[Rollback]

==================================================
ROLLBACK
==================================================

Rollback is deliberately destructive history rewriting.

Do NOT implement rollback as git revert.

When a user rolls back Task X, rollback the configured remote branch to the
PARENT commit immediately before Task X.

If later task commits exist, they are intentionally discarded.

Show a strong confirmation dialog BEFORE rollback.

Example:

"Rollback to before Task #14?

This will discard 3 committed tasks:
#14 Add authentication
#15 Add profile
#16 Add logout

Any currently running task will also be cancelled.

Remote Git history will be rewritten."

Require explicit confirmation.

The rollback operation:

1. acquire exclusive project rollback lock
2. stop the scheduler
3. cancel any currently executing developer task
4. reset the executor's local tracked files back to remote
5. use the rollback initiator's Git credential
6. git fetch origin
7. determine target parent SHA
8. git reset --hard <targetSha>
9. git push --force-with-lease origin <branch>
10. update application state
11. mark removed committed tasks as DISCARDED_BY_ROLLBACK or ROLLED_BACK
12. record rollback initiator
13. broadcast synchronization to all connected clients
14. resume scheduler

Do not use plain --force if --force-with-lease can be used.

If branch protection prevents the force push, abort safely and display a clear
error.

Project onboarding should warn that destructive rollback requires the branch
to permit history rewriting.

The application database must retain records of discarded tasks even though
their commits disappear from the active remote branch.

Display metadata such as:

Rolled back by:
Charlie

==================================================
TASK STATES
==================================================

Implement a deterministic state machine.

Suggested states:

QUEUED
WAITING_FOR_REQUESTER
SYNCING
PLANNING
EDITING
VALIDATING
PUSHING
SYNCING_TEAM
COMMITTED
PAUSED
FAILED
CANCELLED
ROLLED_BACK
DISCARDED_BY_ROLLBACK

The developer daemon should expose:

phase
amendable
shortStatus

Example:

{
  phase: "EDITING",
  amendable: true,
  shortStatus: "Implementing authentication callback"
}

Suggested amendability:

PLANNING:
true

early EDITING:
true

late EDITING:
false

VALIDATING:
false

PUSHING:
false

Do not estimate amendability from elapsed seconds alone.

==================================================
PAUSE / CANCEL
==================================================

Support pause/cancel for the active developer agent.

PAUSE:
- suspend developer execution
- retain project execution lock

RESUME:
- continue same task

CANCEL:
- stop developer execution
- discard tracked local changes
- reset executor to current remote state
- release project execution lock

Rollback always has higher priority and may cancel a paused/active task.

==================================================
OFFLINE EXECUTOR
==================================================

If the next task's requester has no connected daemon:

mark task:
WAITING_FOR_REQUESTER

Do not deadlock the entire project.

Allow scheduler to move to the next executable task.

When the requester reconnects, the task becomes eligible again while
retaining its priority category.

Clearly show the blocked state in the UI.

==================================================
USER SETTINGS
==================================================

Create a user settings modal.

Include:

GitHub:
- connected username
- Git credential configured indicator
- update credential action

Local companion:
- online/offline
- daemon version

Local project mappings:
Project Alpha -> /Users/.../alpha
Project Beta -> /Users/.../beta

Git credentials should preferably remain on the user's local daemon / machine.

Never display or log tokens.

==================================================
PROJECT SETTINGS
==================================================

Add a settings icon/button in the project header.

Clicking it opens a modal or side drawer.

Do NOT permanently dedicate the right sidebar to agent configuration.

Project settings should include:

Repository:
- owner/repository
- configured branch

Agent:
- coordinator model
- developer model
- project agent API credential
- tool permissions

Tool permissions:
- file read
- file write
- shell
- Git
- tests
- network if supported

Local development command configuration:

install command
frontend command
backend command
test command

Examples:

npm install
npm run dev
npm run server
npm test

Allow working directory per command if useful.

Also validate that the user submitting a request has appropriate repository
access.

==================================================
MULTIPLE PROJECTS
==================================================

A user may belong to multiple projects.

Left sidebar should list projects.

Selecting a project loads:

- its queue
- chat/task history
- repository information
- active developer state
- activity log
- local preview state

Execution locks are per project.

Project A and Project B may execute at the same time.

==================================================
UI / VISUAL DESIGN
==================================================

Use the provided visual references as inspiration.

Design a modern browser-based collaborative developer interface.

Style:

- light gray outer page background
- white primary workspace
- thin neutral borders
- large rounded containers
- minimal black primary controls
- subtle gray secondary text
- spacious layout
- clean typography
- monospace only where appropriate
- avoid colorful Discord-like styling
- feel closer to a polished modern coding product

Desktop layout:

LEFT:
project navigation

CENTER:
request queue / collaborative conversation

RIGHT TOP:
local preview

RIGHT BOTTOM:
terminal-style activity feed

TOP HEADER:
project name
member presence
settings button
share/invite button

CENTER TASK CARDS

Each request card should show:

- avatar/name
- request text
- queue status
- task number
- requester
- active/completed indicator
- replies/refinements
- diff after completion
- actions

Queued task order must reflect scheduler order.

A later high-priority refinement must visibly move above older normal requests.

Do not sort task cards by timestamp.

==================================================
ACTIVITY TERMINAL
==================================================

The area labelled "agent config" in the rough wireframe should instead be a
terminal-style real-time project activity feed.

Example:

13:31:02 alice   REQUEST  #14 queued
13:31:04 alice   GIT      syncing origin/main
13:31:06 alice   AGENT    planning
13:31:13 alice   AGENT    editing src/auth.ts
13:31:22 bob     REFINE   merged into #14
13:31:49 alice   TEST     npm test passed
13:31:53 alice   GIT      commit 4af71c2
13:31:55 alice   GIT      pushed main
13:31:56 system  SYNC     broadcasting
13:31:57 bob     GIT      synced 4af71c2
13:31:58 system  TASK     #14 complete

Use monospace text.

Allow scrolling.

Never log API keys, access tokens, secrets or complete sensitive request
headers.

==================================================
LOCAL PREVIEW
==================================================

BONUS FEATURE.

The local daemon should be able to start configured local development
processes automatically after sync.

Examples:

frontend:
npm run dev

backend:
npm run server

Report process information back to web UI:

name
status
port
URL

Show it in the upper-right panel.

If the browser can embed the localhost URL safely, display it.

If iframe embedding fails because of browser security / mixed content /
CORS, provide:

"Preview running at http://localhost:3000"

[Open Preview]

Do not spend excessive hackathon time building a remote tunnelling system.

==================================================
DATABASE MODEL
==================================================

Implement entities equivalent to:

User
Project
ProjectMember
Message
Task
TaskMessage
RollbackAction
ActivityEvent

Important Task fields:

id
projectId
rootMessageId
parentTaskId nullable
type NORMAL | REFINEMENT
status
queuePriority
queueSequence
requestedByUserId
executorUserId
baseCommitSha
commitSha
amendable
createdAt
startedAt
completedAt

Message:

id
projectId
authorId
body
replyToMessageId nullable
createdAt

TaskMessage:

taskId
messageId
role INITIAL | IN_FLIGHT_REFINEMENT

ActivityEvent:

id
projectId
taskId nullable
userId nullable
category
message
createdAt
metadata sanitized

==================================================
WEBSOCKET EVENTS
==================================================

Create typed real-time events approximately equivalent to:

client -> server

DAEMON_CONNECTED
DAEMON_HEARTBEAT
TASK_STATUS
TASK_AMENDABLE_CHANGED
TASK_OUTPUT
GIT_SYNC_RESULT
GIT_PUSH_RESULT
PROCESS_STATUS
ACTIVITY_EVENT

server -> daemon

SYNC_PROJECT
START_TASK
AMEND_TASK
PAUSE_TASK
RESUME_TASK
CANCEL_TASK
START_ROLLBACK
START_LOCAL_PROCESS
STOP_LOCAL_PROCESS

web -> server

CREATE_REQUEST
CREATE_REFINEMENT
PAUSE_ACTIVE_TASK
RESUME_ACTIVE_TASK
CANCEL_ACTIVE_TASK
ROLLBACK_TASK
UPDATE_PROJECT_SETTINGS

server -> web

QUEUE_UPDATED
TASK_UPDATED
MESSAGE_CREATED
ACTIVITY_CREATED
MEMBER_STATUS_CHANGED
SYNC_STATUS_CHANGED
DIFF_AVAILABLE
PROCESS_STATUS_CHANGED

Use shared Zod schemas for validation.

==================================================
SECURITY
==================================================

Do not store plaintext secrets in logs.

Never expose another user's GitHub credential to a browser client.

Validate all WebSocket commands server-side.

Authorize every project action.

A user must belong to the project/repository before being allowed to submit
requests.

All sensitive project settings must be redacted when sent to normal browser
clients.

Use confirmation dialogs for destructive operations.

Treat messages and agent output as untrusted data.

==================================================
HACKATHON PRIORITIES
==================================================

Implement in this priority order:

P0:
1. user/project model
2. browser project UI
3. WebSocket communication
4. local daemon
5. local repo binding
6. normal task queue
7. single execution lock
8. hard sync to remote
9. developer-agent execution abstraction
10. commit + push
11. automatic sync broadcast
12. code diff
13. refinement queue priority
14. in-flight refinement support
15. destructive rollback
16. activity log

P1:
17. pause/cancel
18. repository permission verification
19. better error handling
20. member presence
21. multiple projects

P2 / BONUS:
22. auto-running frontend/backend
23. embedded localhost preview
24. richer diff viewer

If necessary, mock the actual LLM provider behind a clean AgentProvider
interface so the orchestration, Git and UI flow can be demonstrated even if
provider integration is incomplete.

Do NOT mock Git state transitions.

The hackathon demo must visibly demonstrate real Git commits and pushes.

==================================================
DEMO SCENARIO
==================================================

The final application should be capable of demonstrating:

1. Alice and Bob open the same project.

2. Both daemons connect.

3. Alice requests:
   "Add a dark-mode toggle."

4. Alice's machine synchronizes to origin/main.

5. Alice's developer agent begins.

6. While still amendable, Bob replies:
   "Put the toggle inside Settings."

7. Bob's request becomes an in-flight refinement of Alice's active task.

8. Agent completes one combined implementation.

9. Alice's credential creates and pushes the commit.

10. Both Alice and Bob automatically synchronize.

11. The task displays its diff and "Accepted automatically".

12. Another normal request is already queued.

13. Bob now refines the completed dark-mode request:
    "Respect the user's system theme by default."

14. This creates a new REFINEMENT task.

15. Even though it was created later, it visually moves ahead of the older
    normal queued requests.

16. After the current active task completes, Bob's refinement runs next on
    Bob's machine.

17. Bob's credential pushes that commit.

18. Alice initiates a rollback to an earlier task.

19. The UI warns exactly which commits/tasks will disappear.

20. Alice confirms.

21. Active work is cancelled.

22. Alice's Git credential performs force-with-lease rollback.

23. All connected clients automatically synchronize.

24. Activity panel shows the entire operation with attribution.

This demo flow is more important than implementing every optional feature.

==================================================
DELIVERABLE QUALITY
==================================================

Produce clean, readable code suitable for continuing after the hackathon.

Avoid overengineering.

Separate:
- deterministic scheduler/state machine
- coordinator LLM decisions
- developer agent
- Git operations
- WebSocket transport
- UI

Do not let the LLM directly control application queue state or perform hidden
Git state transitions.

All important Git and scheduler actions must be represented explicitly in
application state.

Begin by creating the monorepo architecture and core shared types, then
implement the backend state machine and local daemon before polishing the UI.
