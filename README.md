# Sandflow

A visual (n8n-style) flow builder for coding-agent pipelines. Wire **auto** blocks (git / CLI on your machine),
**AI** blocks (an agent running in a sandbox via [`@ai-hero/sandcastle`](https://github.com/mattpocock/sandcastle))
and **manager** blocks (an agent that picks the next step) together on a canvas, then press **Run**.

Sandflow ships as a **desktop app** (Electron — Windows, macOS, Linux) with auto-update, and can also run in the
browser for development. Either way the flow engine (`backend/`) runs in Node, because git, Docker and the agent CLIs
can't run in a browser.

## Install

Download the installer for your OS from the [latest release](https://github.com/kafuexe/sandflow/releases/latest):
`Sandflow Setup x.y.z.exe` (Windows), `.dmg` (macOS, Apple Silicon or Intel) or `.AppImage` (Linux).
Installed apps check for updates on start and offer to restart into the new version.

Builds are **not code-signed** yet: Windows SmartScreen shows "Unknown publisher" (More info → Run anyway) and macOS
needs right-click → Open the first time. macOS auto-update only works for signed builds.

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

## Air-gapped / on-prem install

The installers are self-contained: the Node runtime, backend, UI, sandcastle, the base skills and the base pack are all
inside. With **App updates: Off** the app makes no network calls of its own (otherwise it checks GitHub for app updates
and, while the installed base pack is still the shipped copy, for a newer base pack). The target machine only needs **git** and a **container runtime**
(Docker or Podman) — or neither runtime if you use *Sandbox: None*.

Each release also ships an **offline bundle** for the sandbox — `sandflow-sandbox-image-<version>-linux-amd64.tar.gz`
(or `-arm64`, plus a `.sha256`). It's the `sandflow-agent:<version>` image (Node 22, git, jq), built from
[`sandbox/Dockerfile`](sandbox/Dockerfile). Sandflow **never pulls images**: before a run it checks the image is
loaded and stops with a clear message if it isn't.

1. On a connected machine, download from the release: the installer for your OS, the sandbox bundle for your CPU
   architecture (and its `.sha256`). Copy them across.
2. Install Sandflow. On Linux use the `.tar.gz` if the AppImage can't run (it needs FUSE / `libfuse2`).
3. **Settings → Sandbox → Import offline bundle**: pick the `.tar.gz` (runs `docker load` / `podman load`).
   Or from a terminal: `docker load -i sandflow-sandbox-image-<version>-linux-amd64.tar.gz`.
4. **Agent CLI.** The image contains no agent — Claude Code is proprietary, so Sandflow doesn't redistribute it. Put
   the **Linux** `claude` executable (or another agent CLI) you obtained through your own channels in a folder and set
   **Settings → Sandbox → Agent tools folder**. It's mounted read-only at `/opt/sandflow/tools`, which is on `PATH`.
   The image already sets `DISABLE_AUTOUPDATER`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` and friends so the CLI
   doesn't try to reach the internet.
5. Point agents at your internal LLM gateway with the block **Endpoint** (see *Custom endpoint* below).
6. **Settings → App updates**: *Off*, or *Internal server* — host a release's `latest*.yml` files and installers on
   an internal web server and enter its URL.
7. Skills: use bundled or uploaded **file** skills; GitHub skills need internet (`npx skills add`).
8. Packs: add them from a **folder** or **zip** (Packs → Add pack), or from your internal GitLab / GitHub Enterprise.

Using your own image? Set **Settings → Sandbox image** to its name (e.g. `registry.corp:5000/team/agent:1`); it must
already be present locally. It should keep `ENTRYPOINT ["sleep", "infinity"]`, a writable `HOME=/home/agent`, and
work for any UID, like `sandbox/Dockerfile`.

## Run from source

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5173 — or run the desktop app from source:

```bash
npm run app
```

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
- **Skills** (block editor → Skills) are installed into the sandbox before a block first runs. Three kinds:
  - **Bundled** — the base skills the built-in blocks use ship in [`skills/`](skills/) (vendored from
    [obra/superpowers](https://github.com/obra/superpowers) and [mattpocock/skills](https://github.com/mattpocock/skills),
    MIT; see each `SOURCE.md`). Pick them from **Add skill**.
  - **From file / From folder** — upload a `SKILL.md` or a skill folder; it's stored in `.sandflow/skills/<name>/` and
    becomes available to every block under **Add skill → Uploaded**.
  - **GitHub** — `owner/repo` + name, installed with `npx skills add <owner/repo> --skill <name>`.

  File skills are copied to `~/.claude/skills/<name>/` for Claude Code agents (other agents skip them with a warning).
  With **Sandbox: None** that is *your own* home directory.
- **Manager**: sees its outgoing connections and routes the task to exactly one of them.
- **Custom endpoint** (AI / manager blocks): point the agent at an on-prem gateway or proxy. The URL is passed as
  `ANTHROPIC_BASE_URL` (Claude Code) or `OPENAI_BASE_URL` (Codex); for other agents set *Endpoint env var*.
  Set it on *AI Agent (template)* to apply it to every agent block. Add auth vars (e.g. `ANTHROPIC_AUTH_TOKEN`)
  to the block's env list. Inside Docker, reach a service on your machine via `host.docker.internal`, not `localhost`.

## Packs: sharing blocks and flows

Blocks, templates and flows can come from **packs** — folders, git repos or zips anyone can make and share. Sandflow
installs the [base pack](https://github.com/kafuexe/sandflow-base-boxes) (the built-in blocks and example flows) on
first start, from GitHub when it can and from the copy shipped in [`packs/base`](packs/) otherwise.

- **Add** (palette → **Packs** → *Add pack*): a GitHub / GitLab link (repo, tag/branch, or a folder inside a repo;
  self-hosted works; private repos use `GITHUB_TOKEN` / `GITLAB_TOKEN` from Inputs), a folder (copied, or **linked** so
  edits show up live), or a zip. Before installing you see its blocks and flows, **every command it can run**, which
  other packs it needs and, for updates, which files changed.
- **Ids**: a pack's items are prefixed with its id (`base/plan`), so packs can't overwrite each other or your blocks.
  Pack blocks and flows are read-only — duplicate one to make your own.
- **Dependencies**: a pack lists the packs it needs (`requires`, semver ranges). Missing ones can be added from the
  review screen; a version clash offers to update the other pack or install anyway. One version of each pack is
  installed at a time, pinned to the commit / content it was installed from.
- **Code**: a **Script** block runs code from its pack (any language, executables) with the inputs as JSON on stdin and
  `{artifact, steer, exit}` written to `$SANDFLOW_OUTPUT`. It runs in a container — the run's sandbox when it needs the
  repo, or the pack's own image / Dockerfile. Each pack's `setup` installs its dependencies into its own copy, so packs
  never clash. Code from a pack runs **on this machine** (Script `where: host`, Shell command blocks, or Sandbox: None)
  only if you allow that pack to.
- **Share** (Packs → *Share my blocks*): pick your blocks and flows; templates and subflows they use come along,
  other packs become `requires`. Download a zip or write a folder, push it to a repo and share the link. The
  [base pack repo](https://github.com/kafuexe/sandflow-base-boxes) is a GitHub template with the full format.

### Flows inside flows

Drag a flow from the **Flows** tab onto the canvas to run it as one step (a **Subflow** block). The inner flow decides
its interface: its **Flow input** block says what it takes (artifact / steer), and each **Flow output** block becomes
a named exit on the subflow node (e.g. `approved` / `rejected`). Its env vars and starting prompt show up in the
parent's Inputs tab, its steps show in the Run tab as `Subflow › Step`, and a flow can't contain itself.

## Triggers & logic

Flows can start themselves. Add a **trigger** block as the first block and switch the flow **Active** (top bar).

- **Schedule**:
  - once at a date and time
  - every N seconds / minutes / hours / days / weeks / months from a start time (keeps the wall-clock time; month ends are clamped)
  - a cron expression with an optional seconds field and a timezone, e.g. `0 9 * * 1-5` (weekdays 09:00) or `0 17 * * 5L` (last Friday 17:00)

  The Block tab previews the next runs. Missed runs while the app is closed are not caught up.
- **GitHub trigger / GitLab trigger**:
  - Events: issue opened, comment on an issue, MR/PR opened, comment on an MR/PR, push.
  - Scope: repository and optional self-hosted host.
  - How events arrive:
    - **Webhook**: enable **Settings → Webhooks**, which starts a separate listener that only serves `POST /hooks/…`, so the app API is never exposed. Copy the trigger's webhook URL from its Block tab into the repo's webhook settings. Use the value of the trigger's secret env var as the GitHub *secret* or GitLab *secret token*; requests are verified (HMAC-SHA256 or token).
    - **Polling**: reads the repo's events API every N seconds through `gh api` / `glab api` (must be logged in). Works behind NAT. Only events after the first poll fire, and the position survives restarts.
- **Manual start**: only the Run button.

The event is available to every block. A trigger's artifact is a readable summary, and in an **If** block the fields are
`trigger.author`, `trigger.body`, `trigger.title`, `trigger.type`, `trigger.labels`, `trigger.branch`, `trigger.number`, `trigger.url`,
and `trigger.raw.…` for the full provider payload.

**If** checks rules on the trigger event, the input artifact (`text`, or `json.…` when it's JSON) or `steer`. Operators:
equals, contains, starts/ends with, regex, one-of, exists, >, <, true/false, each optionally case-sensitive. Rules
combine with ALL or ANY. The block continues out of **true** or **false**; a branch with nothing connected ends that path.
Each If / trigger node can override its block's defaults in the Block tab.

**Post comment** replies on the issue / MR / PR that triggered the run (`gh api` / `glab api` on this machine, so
agents never get git-host credentials).

If a trigger fires while its flow is still running, the event is **queued** (default) or **skipped**. The Run tab
lists recent runs (manual and triggered) and the trigger activity log; a new triggered run of the flow on screen is
followed live on the canvas.

Example (**New → Example: MR comment assistant**): *GitLab trigger* (comment on MR) → *If* (`trigger.author` =
you AND `trigger.body` contains `@sandflow`) → **true** → *Answer comment* (AI reads the comment + repo) → *Post comment*.

## Edit with AI

**Edit with AI** (top bar) opens a chat next to the canvas: describe a flow or a change and an agent builds it; the
canvas updates live, with the nodes it touched highlighted. A flow can have any number of chats (the header switches
between them). Pick the agent under the message box: any agent a block can use — Claude Code, Codex, pi, OpenCode,
Cursor or Copilot — plus an optional model. It runs on this machine with its own login, and can only change the
chat's flow. While it works, the canvas is view-only.

The agent CLI must be installed on the host (`SANDFLOW_<NAME>_PATH`, e.g. `SANDFLOW_CODEX_PATH`, points at a
specific executable). Claude Code reaches Sandflow's tools over HTTP MCP; Codex, OpenCode, Cursor and Copilot through
a small stdio bridge; pi has no MCP support, so it answers with a `sandflow-ops` JSON block that Sandflow validates
and applies (asking it to fix the block if it doesn't apply).

### Agents outside the app (MCP)

Sandflow serves an MCP server at `http://<host>:<port>/api/mcp` with tools to list blocks, read, create, edit and
validate flows, and save custom blocks. The current URL is written to `mcp.json` in the data folder (the desktop app
uses a new port each launch), e.g. `claude --mcp-config <data>/mcp.json`. Add `?flow=<id>` to limit a session to one
flow. The [`sandflow-flows` skill](agent-skills/sandflow-flows/SKILL.md) teaches an agent how to design flows with
these tools — copy it into your agent's skills folder (e.g. `~/.claude/skills/`).

## Data

Everything is stored in a data folder — desktop app: `%APPDATA%\Sandflow\data` (Windows),
`~/Library/Application Support/Sandflow/data` (macOS), `~/.config/Sandflow/data` (Linux); `npm run dev`: `./.sandflow/`.
It holds `library.json` (your blocks), `flows.json` (your flows), `packs/` + `packs.json` (installed packs and what
they're pinned to), `settings.json`,
`env.json` (**secrets — gitignored**), `runs/` (run state, artifacts and agent logs) and `chats/` (Edit with AI
conversations).

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

## Desktop app & releases

- `electron/main.ts` starts the backend on a random `127.0.0.1` port (`backend/server.ts`, which only answers requests
  addressed to that host) and opens the UI in a window. On macOS/Linux it takes `PATH` from your login shell so
  `git`, `docker`, `gh` and the agent CLIs are found. Quitting cancels active runs so sandboxes are torn down.
- `npm run app:dist` builds an installer for the current OS into `release/` (config: `electron-builder.yml`).
- **CI** (`.github/workflows/ci.yml`): typecheck, tests and builds on Windows, macOS and Linux for every push / PR.

### Releasing

```bash
npm version patch
```

```bash
git push --follow-tags
```

`npm version` bumps `package.json` and creates the `vX.Y.Z` tag. The **Release** workflow
(`.github/workflows/release.yml`) then checks the tag matches `package.json`, creates a draft GitHub Release, builds
and uploads the Windows / macOS / Linux installers, and publishes the release — which is what installed apps
auto-update from.

**Auto-update needs public releases.** While the repo is private the app can't read its releases (it logs a 404 and
keeps working). Make the repo public, or publish releases to a separate public repo (change `publish` in
`electron-builder.yml` and give the workflow a token for that repo).

**Code signing** (optional; removes the OS warnings and is required for macOS auto-update): add `CSC_LINK` /
`CSC_KEY_PASSWORD` (and for macOS notarization `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) as
repository secrets, pass them to the *Package* step, and remove `CSC_IDENTITY_AUTO_DISCOVERY: "false"`.
