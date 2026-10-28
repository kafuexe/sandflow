---
name: flow
description: Use when the user wants Sandflow to do a task (it picks the best-fitting flow, starts it and follows it to the result), or to continue / resume, check on, answer, steer or stop a Sandflow run ("the last run", a run id). Runs at a future time go through the schedule skill.
---

# flow

Sandflow runs **flows** (pipelines of agent and automation steps, the agents in sandboxes) on this machine. This
skill turns a request into the right run and follows it to the end.

- Run at a future time ("tonight", "at 9", "tomorrow"): follow [`../schedule/SKILL.md`](../schedule/SKILL.md).
  Register the schedule now and report it; do not start the run or wait in this session.
- Create or change a flow: [`../edit/SKILL.md`](../edit/SKILL.md).

## Tools

Prefer the `sandflow` MCP tools: `list_flows`, `flow_requirements`, `start_run`, `watch_run`, `get_run`,
`answer_question`, `steer_run`, `stop_run`, `list_runs`. If they aren't in this session (not registered, or every
call fails to connect), use the `sandflow` CLI instead: [references/cli.md](references/cli.md). If neither works,
tell the user to install Sandflow (`irm https://raw.githubusercontent.com/kafuexe/sandflow/main/scripts/install.ps1 | iex`
on Windows, `curl -fsSL https://raw.githubusercontent.com/kafuexe/sandflow/main/scripts/install.sh | bash` on
Linux/macOS) and restart Claude Code.

## What does the user want?

| Request | Do |
|---|---|
| A task ("add SSO", "fix #12", "review my branch") | [Start](#start) |
| "continue", "resume", "retry", "pick up", "the last run", a run id | [Continue](#continue) |
| "status", "how is it going" | `get_run` (no id: `list_runs`), summarise status, current step, question, flags |
| An answer to a run's question | `answer_question {runId, answer}`, then keep watching |
| A note for a working agent ("focus on X", "wrap up") | `steer_run` with the step key from `get_run` (subflow steps: `sub/plan`) |
| "stop", "cancel" | `stop_run`, only on an explicit request. A stopped run is never continued automatically |

## Start

1. **Split the work.** One run per independent deliverable, and one per repo when the work spans several repos or
   the user wants each task separately. Coupled work (same code, one part needs the other) stays one run. Several
   runs: see [Several runs](#several-runs).
2. **Pick the flow.** `list_flows` (id, name, size). If the user named one (id or name, loosely), use it.
   Otherwise match the task to each flow's name, description, steps and inputs. `list_flows` has no descriptions:
   get them from `sandflow flows --json` when the CLI is on PATH, or `get_flow` on the likely candidates (its
   steps show what it does). A feature or fix → a flow that plans/implements (and reviews, opens an MR);
   "review" → a review flow; a question or summary → a flow without git steps. Flows started only by a
   trigger (GitHub/GitLab event, schedule) are not for a typed task. State the choice in one line with the reason,
   e.g. "Using **Feature** (plan → implement → review → MR), it fits a new feature." Ask only when it is genuinely
   ambiguous (two flows fit about equally and the difference matters) or nothing fits: offer the top 2–3 with one
   line each, and when nothing fits offer to build one with `/sand:edit`.
3. **Fill the inputs.** `flow_requirements {flowId}` lists what is still empty:
   - starting prompt → the task, in the user's words with all their details (don't shorten it);
   - `REPO_PATH` → the repo the user named; else the current working directory when it is a git repo (say so);
     else ask. Several repos: one run each, each with its own `REPO_PATH`;
   - names you can derive safely (e.g. `BRANCH_NAME` → `feat/<short-slug>`) → set them in `env` and say so;
   - keys, tokens, passwords → never invent or guess. Ask the user to fill them in Sandflow's Inputs tab
     (`sandflow --ui` opens it) and continue when they say it's done.
4. **Start.** `start_run {flowId, prompt, env}`. If it fails listing missing inputs, fill them (step 3) and retry
   once. Tell the user: flow, run id, and what you passed (repo, env).
5. **Watch** it (below) until it ends.

## Watch

`watch_run {runId}`, then again with the returned `cursor` as `after`, until `ended` is true. It returns as soon as
something happens (or after ~9 minutes with `timedOut`: just call again, nothing is lost). Report briefly as you go:
steps done/failed, recoveries, interruptions and continuations. Event-by-event handling:
[references/watching.md](references/watching.md). The essentials:

- **Question** (`pendingQuestion`): if the user already told you the answer, `answer_question`; otherwise ask them
  and pass their answer on. The run waits meanwhile.
- **Hold** (`phase` paused with `hold`): tell the user what is needed (`reason`). It waits until they fix it and
  continue; keep watching.
- **Interrupted / paused** (Sandflow stopped mid-run): say so. It continues when Sandflow runs again or when the
  hourly checker (`sandflow checker install`, see `/sand:schedule`) resumes it.
- **End**: `get_run`, then report the status, what each step produced (the last step's output is usually the
  result, e.g. an MR link) and any error or open flags. Only say it is done when the status is `done`.

If the user moves on, the run keeps going without you; they can come back with `/sand:flow status`.

## Continue

1. **Find the run.** A run id → use it. "The last run" / "the SSO run" → `list_runs` (runs of the Sandflow backend
   the MCP is connected to) or `sandflow runs --json` (history from every Sandflow instance, desktop app included):
   take the newest match by flow, prompt and repo. Several plausible → ask, offering the top 2–3 (flow, status, age,
   prompt snippet).
2. **Check it** with `get_run` (or `sandflow status <runId> --json`) and act on the status:
   - running → just watch it; never start a second run of the same task;
   - waiting on a question → show the question, answer it, watch;
   - held → tell the user what it waits for; continue only after they say it's fixed;
   - paused / interrupted / failed / stopped → continue it with `sandflow resume <runId>` (the MCP has no
     continue tool). Run it as a **background** shell command: it continues the run (a failed run retries from the
     failed step) and follows it, exiting 0 done, 1 failed, 3 waiting on a question, 75 paused again. Meanwhile
     follow it with `watch_run` as usual;
   - done → it is finished. "Continue" on a done run means more work: start a new run of the same flow whose prompt
     names the previous run and its result.
3. If `sandflow resume` says it can't continue a run (e.g. one owned by the desktop app), tell the user to press
   **Continue** on it in the app that ran it.

## Several runs

Up to **3 runs at once**; start the rest as runs finish. Tell each run (in its prompt) to change only its own repo,
and to report changes another repo needs instead of making them. Watch them in turn with short waits
(`watch_run {runId, after, timeoutSeconds: 60}` per run), reporting changes per run. A failed run does not stop the
others. At the end report one line per run: repo, status, result (MR link) or failure.

## Rules

- Don't edit the repo yourself while a run is working on it.
- Don't start a run of the same task while one is going: watch or continue the one you have.
- Never invent secrets or claim success the run didn't report; on failure give the error and how to continue
  (`/sand:flow continue <runId>`).
