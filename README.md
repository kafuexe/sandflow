# Sandflow

A visual (n8n-style) flow builder for coding-agent pipelines. Wire **auto** blocks (git / CLI on your machine),
**AI** blocks (an agent running in a sandbox via [`@ai-hero/sandcastle`](https://github.com/mattpocock/sandcastle))
and **manager** blocks (an agent that picks the next step) together on a canvas, then press **Run**.

It is a single app: `npm run dev` starts one process on one port. The flow engine runs inside the Vite server
(`backend/`, mounted at `/api` by a Vite plugin), because git, Docker and the agent CLIs can't run in the browser.

## Prerequisites

- Node 22+
- Docker Desktop running (or Podman — or choose **None** in Settings to run agents directly on this machine)
- In the **target repo** (the one `REPO_PATH` points to), once:
  ```bash
  npx @ai-hero/sandcastle init
  ```
  ```bash
  npx @ai-hero/sandcastle docker build-image
  ```
- For **Create MR**: `gh` (GitHub) or `glab` (GitLab) installed and authenticated, and an `origin` remote.

## Run

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5173.

1. Pick a flow (the **Feature pipeline** is seeded: Create task → Plan → Implement → CR → Manager → CR fix ↺ / Create MR).
2. Fill the **Inputs** tab: the starting prompt and every env var the flow's blocks need
   (`REPO_PATH`, `BRANCH_NAME`, `BASE_BRANCH`, `ANTHROPIC_API_KEY`, `MR_PROVIDER` = `github` | `gitlab`).
   **Run** stays disabled until everything is filled.
3. Press **Run** and watch the **Run** tab. If a block has *Allow questions* on, the flow pauses and asks you.

`npm start` serves a production build (`npm run build` first) the same way via `vite preview`.

## Concepts

- **Inputs** a block can take: `artifact` and `steer` (via edges), the global **starting prompt**, and global **env vars**
  (a block only declares the names; values live in the Inputs panel and each block gets only the vars it declares).
- **Outputs**: `artifact` (blue edges) and `steer` (dashed amber edges).
- **Templates**: any block or template can *extend* a template. Env vars and skills are merged down the chain,
  everything else is overridden. Edit via the palette (click an item) or **Edit block definition**.
- **Skills**: each block lists recommended skills, installed in the sandbox with
  `npx skills add <owner/repo> --skill <name>` before the block first runs.
- **Manager**: sees its outgoing connections and routes the task to exactly one of them.

## Data

Everything is stored in `./.sandflow/`: `library.json` (blocks), `flows.json`, `settings.json`,
`env.json` (**secrets — gitignored**) and `runs/` (run state, artifacts and agent logs).

## Development

```bash
npm test
```

```bash
npm run typecheck
```

Notes:
- Prompts are always passed to sandcastle as inline strings (never prompt files / `promptArgs`), so agent output
  that flows into the next prompt is never shell-expanded.
- The **Shell command** block runs with the system shell — `cmd.exe` on Windows, so use cmd syntax there
  (`%SANDFLOW_ARTIFACT%`), or run Sandflow under WSL.
- Editing files under `backend/` restarts the Vite server, which cancels any run in progress.
