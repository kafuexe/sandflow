---
name: sandflow-flows
description: Use when asked to create, change, review or explain a Sandflow flow (pipelines of trigger, auto, AI, manager and If blocks) — adding, configuring or wiring blocks. Requires the `sandflow` MCP server.
---

# Building Sandflow flows

Sandflow is a visual builder for coding-agent pipelines. You edit its flows through the `sandflow` MCP server; the
open app updates live.

## Connect

Sandflow serves MCP over HTTP at `http://<host>:<port>/api/mcp` while it's running. The current URL (the desktop app
picks a new port each launch) is written to `mcp.json` in Sandflow's data folder:

- Windows: `%APPDATA%\Sandflow\data\mcp.json`
- macOS: `~/Library/Application Support/Sandflow/data/mcp.json`
- Linux: `~/.config/Sandflow/data/mcp.json`
- `npm run dev`: `./.sandflow/mcp.json` (URL `http://localhost:5173/api/mcp`)

Claude Code: `claude mcp add --transport http sandflow <url>` or `claude --mcp-config <path to mcp.json>`.

Append `?flow=<flowId>` to the URL to limit a session to editing one flow.

## Model

A flow is a graph of **nodes**. Each node places a **block** from the library and may override some of its settings.
Edges carry one of two things:

- **artifact** — the main deliverable (task, plan, summary, review, reply).
- **steer** — short guidance for the next step ("fix these 3 things").

Block kinds:

- **trigger** — starts the flow (Manual start, Schedule, GitHub/GitLab event). No inputs; outputs an artifact describing the event.
- **auto** — deterministic step on the host: Create task (makes the branch), Create MR, Shell command, Post comment.
- **ai** — an agent in a sandbox: Plan, Implement, CR, CR fix, Answer comment, or custom blocks.
- **manager** — an agent that sends the task down exactly ONE of its outgoing edges. Give it 2+ targets.
- **condition** (If) — deterministic rules; continues out of `true` or `false`. An unconnected branch ends that path.
- **script**, **subflow**, **flow-input** / **flow-output** — pack code, a flow inside a flow, and that flow's entry/exits.

Nodes with no incoming edge are start nodes. Loops are allowed (CR → Manager → CR fix → CR); the engine caps total steps.

## Tools

| Tool | Use |
|---|---|
| `list_blocks` | Block ids, kinds, inputs/outputs, env. Filter: `{kind: "trigger"}`, `{query: "review"}` |
| `get_block` | One block: defaults, the overrides you can set (types + examples), what still needs setting, an example op |
| `list_flows` / `get_flow` | Find a flow; its nodes, edges, validation and inputs still empty |
| `add_node` | Place ONE block and wire it: `{block, id?, from?, to?, overrides?}` |
| `update_node` | Change a node; `overrides` merge in (null removes a key) |
| `connect` | `{from: "a", to: "b"}` wires every compatible handle; `{edges: ["a.steer -> b.steer"]}` for exact ones |
| `edit_flow` | Several ops at once, all-or-nothing; `dryRun: true` checks without saving |
| `create_flow` / `replace_flow` | A whole flow in one call (`create_flow` isn't available in the in-app chat) |
| `validate_flow` / `flow_requirements` | Problems / env vars and starting prompt the user must fill in |
| `save_block` | New reusable block or template (rarely needed) |

Every edit returns the change list, the whole flow, errors/warnings and the inputs still empty — read it instead of calling get_flow again.

## Placing blocks

- `block` takes the full id (`base/plan`), the id without its pack (`plan`) or the name (`Shell command`). Unknown ids get a "did you mean".
- `id` is optional: it defaults to the block id without its pack (`plan`, then `plan-2`). Choose ids when you'll reference them later (`review`, `only-mine`).
- `from` / `to` wire the new node in the same op. A bare node id wires every compatible handle (plan → implement gets artifact AND steer); `node.handle` wires one (`check.true`, `plan.steer`, `review.exit:approved`). They may name nodes added later in the same batch.
- `overrides` hold only what differs from the block. Unknown or misplaced fields are rejected with the list of valid ones; `get_block` shows them.
- Layout is automatic — never send coordinates.

## Recipes

AI step after an existing node, with a tweak:
`{"op": "add_node", "id": "security", "block": "base/cr", "from": "impl", "to": "manager", "overrides": {"extraInstructions": "Focus only on security issues."}}`
(`extraInstructions` is appended to the block's prompt; `instructions` replaces it. Also: `allowQuestions`, `agent: {"model": "…"}`, `maxIterations`.)

Shell command step:
`{"op": "add_node", "id": "tests", "block": "base/shell", "from": "impl", "overrides": {"shellCommand": "npm test"}}`

Triggers:
- Schedule: `{"op": "add_node", "id": "nightly", "block": "base/schedule-trigger", "overrides": {"trigger": {"schedule": {"kind": "cron", "expr": "0 0 9 * * 1-5"}}}}` (cron has a seconds field; also `{"kind": "interval", "every": 2, "unit": "hours"}`)
- GitHub/GitLab: `{"op": "add_node", "id": "gh", "block": "base/github-trigger", "overrides": {"trigger": {"repo": "acme/web", "events": ["merge_request.comment"]}}}`

If branch:
`{"op": "add_node", "id": "only-mine", "block": "base/if", "from": "gh", "to": "answer", "overrides": {"condition": {"match": "all", "rules": [{"field": "trigger.author", "op": "equals", "value": "alice"}]}}}`
— a bare If node in `from`/`to` means its `true` branch; wire the other with `{"op": "connect", "from": "only-mine.false", "to": "skip"}`.

Rewire: `{"op": "disconnect", "from": "cr", "to": "manager"}` removes every edge between them; `{"op": "remove_node", "id": "x"}` drops its edges too.

Whole flow in one call (`replace_flow`, or `create_flow` with a `name`):
```json
{"nodes": [
  {"id": "start", "block": "base/create-task"},
  {"id": "plan", "block": "base/plan", "from": "start"},
  {"id": "impl", "block": "base/implement", "from": "plan"},
  {"id": "review", "block": "base/cr", "from": "impl"},
  {"id": "manager", "block": "base/manager", "from": "review", "to": ["mr", "fix"]},
  {"id": "mr", "block": "base/create-mr"},
  {"id": "fix", "block": "base/cr-fix", "to": "review"}
]}
```

## Edge syntax

`source.handle -> target.handle` with node ids, e.g. `plan.steer -> implement.steer`. Handles default to artifact. Sources: `artifact`, `steer`, `true`/`false` (If), `exit:<name>` (Script / subflow). Targets: `artifact`, `steer`. Triggers take no inputs.

## Condition rules

Fields: `text` (input artifact), `steer`, `json.<path>`, `trigger.<path>` (type, author, body, title, labels, branch…).
Ops: equals, not_equals, contains, not_contains, starts_with, ends_with, matches (regex), in (comma list), exists, not_exists, gt, lt, is_true, is_false.

## Inputs and env

Blocks declare env var NAMES (`REPO_PATH`, `ANTHROPIC_API_KEY`, `BASE_BRANCH`…); add more to a node with `overrides.env: ["JIRA_TOKEN"]`. You can't set values or run flows — the user fills them in the Inputs tab. Edit results end with what's still empty; tell the user.

## Working method

1. `get_flow` (and `list_blocks` if you don't know the ids). `get_block` before configuring an unfamiliar block.
2. Make the change in as few calls as possible: `add_node` with `from`/`to`, or one `edit_flow` batch.
3. Fix every error in the result (each names the op and the field). Warnings flag likely mistakes, e.g. a Shell command with no command.
4. Prefer node `overrides` over new blocks. Only `save_block` for something reused across flows; extend a template (`base/tpl-ai-agent`, `base/tpl-auto-git`, `base/tpl-reviewer`).
5. Finish by telling the user what changed and which inputs they still need to fill in.

## Common shapes

- Feature: Create task → Plan → Implement → CR → Manager → (Create MR | CR fix → CR).
- Answer comments: GitHub/GitLab trigger → If (author/keyword) → Answer comment → Post comment.
- Scheduled job: Schedule → Shell command or an ai block.
