# Durable runs — design (part 1 of 3)

Sandflow runs should survive crashes, quits and app updates the way [MEOW](https://github.com/maya8237/MEOW) runs do.
MEOW's implementation and decisions are the model (its `execution/run_state.py`, `cli/resume_cli.py`,
`infrastructure/cancellation.py`, `infrastructure/background.py`, `orchestration/store.py`, `agents/base.py`); this
spec maps them onto Sandflow's engine. Where this spec and MEOW disagree, this spec wins.

Roadmap:

1. **Durable runs** (this spec): a run continues after a crash / quit / update as the same run; Claude Code can start
   and watch runs.
2. Supervisor tick: a timed check of running blocks (stuck / silent agents, timeouts), raising flags and acting.
3. Recovery: retries, review-before-redo, a triage agent with a bounded recovery budget.

## Goals (what the user asked for)

- Interrupted runs **continue automatically** when Sandflow starts again (per-flow switch to turn it off).
- **Quit and app updates pause** running flows instead of cancelling them; they continue on next start. Stop still
  cancels, and a cancelled run is never continued automatically.
- Interrupted blocks **re-run**; an interrupted agent first **continues its own Claude session**.
- The **Claude that started a run** (from Claude Code) is told when it is interrupted / continued: it **watches** the
  run through a Sandflow MCP tool that returns on each event.
- Claude Code can **start runs**; a Sandflow skill for that is **installed into Claude Code with Sandflow**.

Success: kill Sandflow mid-run, start it again — the run carries on under the same id; finished blocks aren't redone;
the interrupted agent continues its session (or gets a "check what's done" prompt); worktree changes are kept.

## 1. The run journal

`runs/<id>.json` (today's `RunState`) becomes a journal that is enough on its own to continue the run.

- **Atomic, durable writes**: temp file in the same directory → write → fsync → rename (MEOW `_write`). Today's
  `writeAtomic` gains the fsync.
- **`schemaVersion`** on every journal. **Strict load, fail closed**: a journal that doesn't validate is never
  continued; it's preserved as-is and the run is flagged "corrupt — preserved at <path>".
- **Phases + transitions** (MEOW `phase` / `transitions[]`): `run.phase` ∈ `running | waiting | pausing | paused |
  interrupted | continuing | done | failed | cancelled`, and `run.transitions[]` appends `{phase, at, attempt}` on every
  change. `run.attempt` counts continuations (1 = first start). One `TERMINAL_PHASES` set (`done | failed |
  cancelled`) decides "this run no longer does work". `status` stays for the UI and is derived from phase.
- **Active / completed blocks** (MEOW `workflow.active` / `completed`): before a node runs its attempt is journaled
  `active` (with `startedAt`); when it finishes it is `completed` with its outputs. Continuing skips completed nodes and
  re-runs active ones. Node keys include the subflow prefix (`sub/plan`), so subflows are covered.
- **Live queue + step count**: the top-level queue and every in-progress subflow's queue (node id + the inputs it will
  receive) and `steps` are journaled whenever they change — not only in the engine's `finally` as today's `unstarted`.
- **`interrupted_mutation`**: a node whose attempt was cut off while it could change files (ai, manager, auto shell /
  create-mr / merge-parent, script, integration) is marked `interrupted: "mutation"`; others `interrupted: "plain"`.
- **Fingerprints** (MEOW `plan_fingerprint` / `config_fingerprint` / workflow fingerprint), stamped at first start:
  - `flow`: sha256 of the normalized flow and every block definition it reaches (template chain, subflow and Box Stack
    flows, recursively);
  - `settings`: the settings that change behaviour (sandbox kind, image, maxSteps, runOn defaults);
  - `workspace`: repo path, branch, and the commit the branch was at when the run started.
- **Agent sessions per node** (MEOW `sessions{role: id}`): an agent node's Claude session id (`Steering.seeLine`
  already reads it) and where it ran (`host` | container id) are journaled the moment they appear. A failed journal
  write only logs; it never fails the agent.
- **Usage per node** (tokens, cost) appended as results arrive, when the agent reports it.
- **Redaction** (MEOW `_safe`): values of secret-named env vars never enter the journal; very long outputs are capped
  in the journal (full text stays in the artifact files).
- **Save timing**: journaled immediately (not throttled) on node start / finish, queue change, phase change, session
  id. Log lines and activity keep the existing ~2 s batching.
- **Box Stacks**: children are already separate runs; each journals and continues like any run. The stack node
  journals which tasks are done / running / pending so continuing doesn't redo finished tasks.

## 2. Pausing and continuing

**Pause (quit, update)** — cooperative, like MEOW's cancel marker:

1. Journal `pausing` first.
2. Running nodes get a short grace period (5 s), then their processes are stopped; their attempt is marked
   `interrupted` / `interrupted_mutation`.
3. Journal `paused` with `pauseReason` (`quit` | `update`).

`api.shutdown()` pauses instead of cancelling; the desktop app's "Any running flow will be cancelled" text changes.
**Stop** (`cancel`) is unchanged → `cancelled`.

**Irreversible steps aren't cut in half** (MEOW `delivery_lock`): Create MR, push, Post comment and merge-parent run
under a per-run delivery lock; pause / stop waits for it (≤ 30 s) instead of interrupting mid-step.

**Idempotent delivery** (MEOW): Create MR saves the MR URL in the journal and, if one is saved (or the provider
already has an open MR for the branch), reuses it; push is skipped when the remote branch already has the commit;
Post comment saves the comment id and won't post the same node's comment twice.

**One driver per run** (MEOW `DriverLock`): `runs/<id>.lock`, created exclusively, holding Sandflow's pid and its
process start time. Another Sandflow on the same data folder leaves the run alone. A lock whose owner is dead (pid gone
or start time differs) is reclaimed once.

**The continue pass on start** (MEOW tick reconcile + `resume --continue`):

1. Scan journals not in a terminal phase.
2. `running` / `waiting` / `pausing` with no live lock owner → crash: journal `interrupted` (`pauseReason: crash`);
   still-active nodes get `interrupted` / `interrupted_mutation`.
3. Each `paused` / `interrupted` run is validated in MEOW `_validate` order: journal valid → repo exists → branch exists
   → worktree present or re-creatable from the branch → fingerprints match.
   - **Mismatch** → stays `paused`, flagged with exactly what failed, and a **Repair** action: adopts the current
     state (new fingerprints, re-created worktree), lists each change, journals the patch (MEOW `--repair`). Without
     a project (scratch workspace) a mutation-interrupted run can't be validated → waits for the user.
   - **Pass** → continues under the same id: `attempt + 1`, `continuing` → `running`.
4. Per-flow setting `continueAutomatically` (default on). When off, interrupted runs wait with a **Continue** action
   (which runs the same validation).

Manual **Continue** and **Repair** are API routes (`POST /runs/:id/continue`, `POST /runs/:id/repair`) and buttons in
the Run tab.

**Where it picks up** (MEOW `_resume_at`):

- Completed nodes are skipped; the journaled queues are restored; `steps` continues from the journal.
- **Interrupted agent nodes** first, continuing their own Claude session on the first call only (MEOW sets `resume`
  for a role's first query only), with: *"You were interrupted. Check the work in the repo against your task, don't
  redo what's finished, then complete it."* If the session can't be continued (container session gone, session file
  missing, resume fails), the agent starts fresh with the same message plus its original task (MEOW `--repair` path).
- **Interrupted shell / script / integration nodes** re-run from their journaled inputs.
- **Subflows** continue inside from their own journaled queue; **Box Stack** children continue as runs.

**Leftover cleanup**: the journal records each sandbox's container id and agent process pids with their start
identity. On continue (and on start for crashed runs), ones that still exist and match are removed / killed before the
run goes on. No orphan is killed unless its recorded identity matches.

## 3. Claude Code: start and watch runs

- **MCP run tools** on Sandflow's existing MCP server (`backend/mcp.ts`):
  - `start_run {flowId, prompt?, env?}` → run id (fails with the missing inputs, like `POST /runs`);
  - `watch_run {runId, after?}` → waits (long-poll, ≤ ~10 min) until the run has new events after the cursor, then
    returns them: phase changes (interrupted / paused / continuing / done / failed), node finished / failed, a pending
    question, flags; plus a new cursor. Events are derived from the journal, so a watcher that reconnects later still
    sees what happened (MEOW: "the event waits in the run for next time");
  - `answer_question {runId, answer}`, `steer_run {runId, nodeId, message}`, `stop_run {runId}`,
    `get_run {runId}` (status, phase, per-node summary, outputs), `list_runs {flowId?}`.
- **Who started it**: runs started through MCP record `startedBy: {kind: "claude-code", label}`; the Run tab shows it.
- **Stable connection**: the desktop app's port changes each launch, so Claude Code is registered with a stdio bridge
  (`MCP_BRIDGE` already exists) that reads the current URL from `<data>/mcp.json` at start, instead of a fixed URL.
- **Installed with Sandflow**: on app start (and from the installer), if Claude Code is present (`~/.claude` exists),
  Sandflow:
  - writes the bridge script to its data folder and registers the `sandflow` MCP server at user scope
    (`claude mcp add --scope user …`, or by editing `~/.claude.json` if the CLI isn't on PATH), replacing an older
    Sandflow entry;
  - installs the skills into `~/.claude/skills/`: the existing `sandflow-flows` and a new **`sandflow-runs`** ("start
    a Sandflow flow, then watch it until it finishes; report interruptions/continuations, answer questions"), keeping
    a version marker so updates replace them and user-modified copies are left alone;
  - a Settings toggle **Claude Code integration** (default on) turns this off and removes what it added.

## Error handling

- Corrupt journal → never continued, preserved, flagged (fail closed).
- Validation failure → paused with a named reason + Repair; nothing runs.
- Session can't be continued → fresh session with the recap message; logged.
- Journal write failure during a run → logged as a warning; the run goes on (MEOW logs and continues for session /
  usage writes).
- A run continued more than `maxContinues` times (default 5) without a node finishing is not continued automatically
  again (prevents crash loops); it waits with a flag.

## Testing

- Journal: atomic write, schema validation (corrupt → preserved + flagged), redaction, fingerprints (change one block
  in a template chain → mismatch).
- Engine: kill mid-run (simulate by abandoning the handle and loading the journal) → continue → completed nodes not
  re-run, queued nodes run, interrupted node re-runs, steps continue; subflow mid-way; Box Stack with some tasks done.
- Pause: shutdown pauses (not cancels); delivery lock defers pause; idempotent Create MR / Post comment.
- Driver lock: second owner refused; dead owner reclaimed.
- Agent: session resumed on first call only; fallback to fresh with recap when resume fails.
- Continue pass: crash → interrupted → validated → continued automatically; flow edited → paused + Repair works;
  `continueAutomatically: false` waits; `maxContinues` stops a loop.
- MCP: start_run, watch_run cursor semantics (events survive a restart), answer / stop; installer writes skills +
  registration idempotently and respects the toggle.
