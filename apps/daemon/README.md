# Relaycode local companion

The companion is the only Relaycode component that touches a developer's files, shell, Git credentials, or local processes. Git credentials remain on this machine. A shared project OpenAI key is delivered only to the assigned companion for task execution and is never logged.

## Configure

```sh
npm run configure -w @relaycode/daemon -- \
  --server-url http://localhost:4000 \
  --user-id alice \
  --token "$RELAYCODE_DAEMON_TOKEN" \
  --agent-provider openai

npm run configure -w @relaycode/daemon -- project project-alpha \
  --path /Users/alice/code/project-alpha \
  --remote git@github.com:example/project-alpha.git \
  --branch main
```

Configure the shared OpenAI key once in the web app under **Project settings → Agent**. `OPENAI_API_KEY` remains an optional local fallback for headless use and is removed from the environment of model-controlled shell commands.

Use `--agent-provider command --agent-command "your-agent-command"` to run any local newline-JSON agent, or `--agent-provider demo` for a deterministic hackathon flow that writes `relaycode-demo.md` and creates a real Git commit.

## Run

```sh
npm run dev -w @relaycode/daemon
```

The daemon validates that each mapping is the repository root and that `origin` matches the project remote. For every task it fetches and hard-resets tracked files to `origin/<branch>`, preserves pre-existing untracked files, executes the agent, fetches again, and only commits/pushes if the remote SHA still equals the recorded base SHA. Rollback exclusively uses `--force-with-lease`.
