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

## Data

Everything is stored in a data folder — desktop app: `%APPDATA%\Sandflow\data` (Windows),
`~/Library/Application Support/Sandflow/data` (macOS), `~/.config/Sandflow/data` (Linux); `npm run dev`: `./.sandflow/`.
It holds `library.json` (blocks), `flows.json`, `settings.json`,
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
