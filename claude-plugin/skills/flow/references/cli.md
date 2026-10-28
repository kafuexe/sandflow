# The sandflow CLI (fallback when the MCP tools are missing)

The installer puts `sandflow` on PATH (`~/.sandflow/bin`). Every command that needs the backend starts the
Sandflow daemon by itself. Use `--json` whenever you parse the output.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | OK / the run is done |
| 1 | Failed or error: report it |
| 2 | Usage error: fix the command (check `sandflow <command> --help`) |
| 3 | The run waits on a question: show it (`sandflow status <runId> --json`), answer with `sandflow answer` |
| 75 | The run is paused or held: it can continue later (`sandflow resume <runId>`, or the hourly checker) |

## Commands

| Task | Command |
|---|---|
| List flows (id, name, description, required inputs) | `sandflow flows --json` |
| Start a run, return at once | `sandflow run <flow id or name> "<prompt>" --repo "<path>" --env K=V --detach --json` → `{runId, ...}` |
| Start and follow | `sandflow run <flow> "<prompt>" --repo "<path>"` (streams step events; exits per the table) |
| Recent runs (history from every Sandflow instance) | `sandflow runs --json` (`--all` for older ones) |
| A run's status, steps, question, flags, cost | `sandflow status <runId> --json` |
| Continue a run and follow it | `sandflow resume <runId>` |
| Answer a question | `sandflow answer <runId> "<text>"` |
| Stop a run | `sandflow stop <runId>` |
| Logs | `sandflow logs <runId>` (`--follow` to stream) |
| Open the UI (Inputs tab, the run view) | `sandflow --ui` |

## Following a run from a Claude Code session

Commands that follow a run can take long, so run them as **background** shell commands, never in the
foreground where a tool timeout would cut them off (cutting them off doesn't stop the run, but you lose the
stream). Without a terminal they never prompt: a question ends them with exit 3.

1. Start: `sandflow run <flow> "<prompt>" --repo "<path>" --detach --json`, note `runId`.
2. Follow: `sandflow logs <runId> --follow` in the background, or check `sandflow status <runId> --json` now and
   then. Report steps done/failed, recoveries and the result as in [watching.md](watching.md).
3. Question (exit 3, or a pending question in `status`): ask the user, `sandflow answer <runId> "<answer>"`, keep
   following.
4. Paused / failed and the user wants it continued: `sandflow resume <runId>` in the background.

The flow picking, inputs and several-runs rules in the skill apply unchanged: `flows --json` gives the same
names, descriptions and required inputs as `list_flows`.
