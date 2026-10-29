# Sandflow

Visual flow builder for sandboxed coding agents: chain automatic steps and AI agents (Claude Code, Codex, …)
into flows that run in Docker / Podman sandboxes. This package is the whole of Sandflow without the desktop app:
the `sandflow` command, its background server and the web UI.

Needs **Node.js 22+**, Git, and Docker or Podman for the sandboxes.

## Install

```bash
npm install -g sandflow
sandflow ui            # start Sandflow and open the UI in your browser
```

Optional, for Claude Code (adds `/sand:flow`, `/sand:schedule`, `/sand:edit` and the `sandflow` MCP server):

```bash
sandflow setup
```

## Use

```text
sandflow ui [--port N]                 Open the Sandflow UI in your browser
sandflow flows                         List flows and the inputs they need
sandflow run <flow> [prompt]           Start a run and follow it (--detach to not wait)
sandflow runs                          Recent runs (CLI and desktop app)
sandflow -r                            Pick a recent run and continue it
sandflow status | answer | stop | logs <runId>
sandflow schedule add|list|edit|cancel Run a flow later (OS scheduler)
sandflow checker install               Hourly task that continues paused runs
sandflow serve | shutdown              Run / stop the background server yourself
sandflow mcp                           Stdio MCP server for Claude Code
sandflow --help                        Everything, and `sandflow <command> --help`
```

Your flows, settings and runs live in `~/.sandflow` (or `$SANDFLOW_HOME`), so `npm update -g sandflow` and
reinstalls keep them. Run `sandflow shutdown` before updating so the running server picks up the new version.

### Sandbox image

Flows run in the local `sandflow-agent:<version>` image (Sandflow never pulls images). This package ships its
Dockerfile, so build it once per version:

```bash
docker build -t "sandflow-agent:$(sandflow --version)" "$(npm root -g)/sandflow/sandbox"
```

(or `podman build …`). Alternatively pick your own image in the UI under Settings → Sandbox, or set the sandbox to
*none* to run agents directly on this computer.

More: <https://github.com/kafuexe/sandflow>
