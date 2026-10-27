---
name: sandflow-runs
description: Use when asked to run a Sandflow flow, or to check on, answer, steer or stop a Sandflow run — start it, then watch it until it ends, reporting interruptions, continuations, questions and the result. Requires the `sandflow` MCP server (Sandflow must be running).
---

# Running Sandflow flows

Sandflow runs flows (pipelines of agent and automation steps) on the user's machine. You start and follow runs
through the `sandflow` MCP server. To create or change a flow, use the `sandflow-flows` skill instead.

If the `sandflow` tools fail with "Sandflow isn't running", ask the user to open the Sandflow app — the tools
reconnect on their own once it's up.

## Tools

| Tool | Use |
|---|---|
| `list_flows` | Find the flow id |
| `flow_requirements` | Inputs a flow needs (starting prompt, env vars) and which are still empty |
| `start_run` | `{flowId, prompt?, env?}` → run id. Fails listing missing inputs |
| `watch_run` | `{runId, after?}` → waits until something happens, then `{status, events, cursor, ended}` |
| `get_run` | Status, each step's state and output, the question it waits on, flags |
| `answer_question` | `{runId, answer}` for a step that asked something |
| `steer_run` | `{runId, nodeId, message}` — a note to an agent step while it works |
| `stop_run` | `{runId}` — cancels the run |
| `list_runs` | Recent runs (`{flowId?}`) |

## Starting

1. `list_flows` to find the flow; `flow_requirements` if you're unsure what it needs.
2. `start_run` with `prompt` set to the task in the user's words (unless they said to use the one set in Sandflow).
   `env` sets inputs for this run only (e.g. `{"BRANCH_NAME": "feat/login"}`); never invent secrets — if a key or
   token is missing, ask the user to fill it in Sandflow's Inputs tab.
3. Tell the user the run started (flow and run id), then watch it.

## Watching

Call `watch_run {runId}` and keep calling it with the `cursor` it returns as `after` until `ended` is true. Each call
returns as soon as there's news (or after ~9 minutes with `timedOut` and no events — just call again; nothing is
lost, events are kept in the run). Report as you go, briefly:

- `node` done / failed — a step finished ("Plan done", "Implement failed: …"). Mention failures with their error.
- `question` with `pending` — a step is waiting for an answer. If the answer is clearly in what the user already
  told you, answer with `answer_question`; otherwise ask the user and pass their answer on. The run waits meanwhile.
- `flag` — something needs a look (stuck agent, warning). Tell the user.
- `phase` `interrupted` / `paused` — Sandflow stopped (crash, quit, update) mid-run. Say so; it continues on its own
  when Sandflow starts again (unless that's turned off for the flow). Keep watching.
- `phase` `continuing` — the run picked up where it left off (`attempt` counts the continuations). Say so.
- `recovery` — a step failed and Sandflow's recovery acted on it: `cause` (error, crash, transient, timeout, stuck,
  sandbox), then `decision` — an automatic or triage `retry` / `resume` / `rescope`, a `skip`, or `blocked` / `hold`
  with a `guard`. Mention retries briefly. A hold pauses the run (`phase` `paused`, `hold` in the result): tell the
  user what's needed (`reason`) — it waits until they fix it and press Continue in Sandflow (or stop it). Keep watching.
- `end`, or `phase` `done` / `failed` / `cancelled` — the run is over.

When it ends, `get_run` and give the user the outcome: status, what each step produced (the last step's output is
usually the result — e.g. an MR link or a summary), and any error or open flags.

If your session gets cut off, a later `watch_run` with the last cursor (or `get_run`, then `watch_run` without a
cursor) catches up on everything that happened.

## Acting on a run

- Steer only when the user asks or a step clearly went off course: `steer_run` with the step's key from `get_run`
  (subflow steps look like `sub/plan`).
- Stop only when the user asks: `stop_run`. A stopped run is never continued automatically.
- Don't start a second run of the same flow for the same task while one is going — watch the one you have.
