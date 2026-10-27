# Supervisor tick and recovery — design (parts 2 and 3)

Follows [durable runs](2026-10-27-durable-runs-design.md) (part 1). Modelled on MEOW: its orchestrator `_Supervisor`
tick (`execution/orchestration/tick.py`, `runner.py`), triage (`orchestration/triage.py`), narrow retries
(`agents/base.py` `run_query` / `_looks_like_a_crash`) and session recycling (`SessionAgent._turn`). MEOW source:
`C:/projects/temp/ext-meow/meow/src/meow`. Where this spec and MEOW disagree, this spec wins.

## Shared contract (both parts build on it)

- **A failure has a cause.** When a node fails, its `NodeRunState.failure = {cause, message, at}` is journaled, cause ∈
  `error` (the block itself failed: non-zero exit, agent error) · `timeout` (its time limit) · `stuck` (the supervisor
  stopped it) · `crash` (crash-like exit: negative / signal / NTSTATUS-high-bit codes, as MEOW `_looks_like_a_crash`) ·
  `transient` (OS / network / CLI connection errors, as MEOW `_is_os_failure`) · `sandbox` (its container vanished) ·
  `interrupted` (cut off by pause / crash — part 1).
- **Stopping one node with a cause**: the engine exposes `stopNode(key, cause, message)` on the run context /
  `RunHandle`: it aborts only that node's work (agent turn via `interruptAgent`, process tree via its own abort
  controller) and the node then fails with that cause. Part 2 calls it; part 3 handles what follows.
- **What happens after a failure is decided in one place**, `decideAfterFailure(...)` (part 3). Without part 3 (or with
  recovery off) a failure fails the run, as today.

## Part 2 — Supervisor tick

One supervisor loop per Sandflow (`backend/supervisor.ts`), started by the API, ticking every `pollSeconds` (Settings
→ Supervisor; default 10 s). Like MEOW's tick it does cheap, deterministic checks every tick and hands judgement to an
agent only when asked. The loop must use an injectable clock/sleep for tests.

**Each tick, for every live run** (the API's `runs` map, stack children included):

1. **Heartbeat the driver lock** (MEOW native-lock heartbeat): refresh `runs/<id>.lock`'s timestamp; part 1's
   reclaim of a lock also treats one not refreshed for 10 × `pollSeconds` as stale when its owner can't be checked.
2. **Liveness** of each running node: `lastActivityAt` = the latest of its log lines, agent activity, output. Journaled
   (throttled, not every line).
   - Silent longer than `silentAfterSeconds` (default 10 min agents, 15 min others) → a warning flag "<node> has been
     silent for N min" (once per silence) and a supervision event.
   - Silent longer than `stuckAfterSeconds` (default 30 min) → `stopNode(key, "stuck", …)`.
   - Sandflow sets sandcastle's own idle timeout above `stuckAfterSeconds` so the supervisor, not sandcastle, decides.
3. **Time limits**: a new block / node setting `timeoutSeconds` (every kind; inherited like other config; unset = no
   limit, except Shell command default 30 min) → exceeding it calls `stopNode(key, "timeout", …)`. Script and
   integration blocks keep their own existing timeouts as their defaults.
4. **Loops**: a node that ran ≥ `loopWarnAfter` (default 5) times in this run with an identical output to its previous
   execution → a warning flag (no action; `maxSteps` still bounds it).
5. **Waiting**: a run waiting on a question longer than `remindAfterSeconds` (default 30 min) → a reminder event (watchers
   / the Run tab see it), repeated at most hourly.
6. **Sandboxes**: a running node whose journaled container no longer exists (`docker/podman inspect`, at most every
   60 s per container) → `stopNode(key, "sandbox", "its container is gone")`.

**Overseer agent** (optional, per flow: Inputs tab → *Overseer*, default off; settings: agent / model, default Claude
Code with a small model, `everySeconds` default 300): while the run has a running **agent** node, every `everySeconds`
the supervisor runs one short, read-only agent turn on this machine (`claude -p`, no tools) that gets, per running agent
node: its task (instructions + input, trimmed), the last ~150 lines of its activity, how long it has run, and the
previous overseer verdicts. It must answer JSON `{"verdict": "ok" | "concern" | "stuck", "node": key, "message": "…",
"action": "none" | "steer" | "restart"}` (MEOW: agents write a decision file the code validates).
- `ok` → nothing (journaled). `concern` + `steer` → the message is sent to that agent with the existing steering
  (`RunHandle.steer`). `stuck` / `restart` → `stopNode(key, "stuck", message)`.
- Guards (MEOW `_refusal`): invalid / missing JSON → ignored + logged; at most 3 steers and 1 restart per node
  execution; an identical message to the previous steer isn't sent again; overseer failures never fail the run.

**Journal + events**: `run.supervision[]` (append-only `{at, node?, kind: "silent" | "stuck" | "timeout" | "loop" |
"reminder" | "sandbox" | "overseer", detail, action?}`, capped at 500). `shared/runEvents.ts` reports them as
`{type: "supervisor", …}` events to watchers (Claude Code `watch_run`). The Run tab shows them in the log and as flags.

**Settings** (Settings → Supervisor): `enabled` (default on), `pollSeconds`, `silentAfterSeconds`, `stuckAfterSeconds`,
`remindAfterSeconds`. Per flow: overseer on/off + agent/model/everySeconds. Per block/node: `timeoutSeconds`.

## Part 3 — Recovery

`backend/recovery.ts`: `decideAfterFailure(ctx, node, cfg, failure, history)` is called by the engine when a node
fails, before the run fails. It returns one of `retry` (run the node again, maybe with notes), `fail` (today's
behaviour) or `hold` (pause the run for a human, part 1's paused + `hold` with reason `blocked`).

**1. Narrow automatic retries** (MEOW: "only SDK crash recovery and explicit loops retry"): causes `crash`,
`transient`, `sandbox`, `stuck`, `timeout` are retried automatically up to `recovery.maxRetries` (default 2) with
exponential backoff (1 s, 2 s, 4 s…, capped 60 s). `error` is **never** blindly retried (semantic failures need
judgement → triage).

**2. Review before redo** (MEOW `interrupted_mutation` → resume at review): a retried **agent** node continues its own
Claude session (part 1's mechanism) with: *"Your previous attempt <cause>: <message>. Check the work in the repo against
your task, don't redo what's finished, then complete it."* — fresh-session fallback as in part 1. Non-agent nodes re-run
from their inputs. For `stuck` / `timeout` agents the session is resumed only once; a second retry starts fresh (MEOW
recycles a session that keeps failing).

**3. Triage agent** (per flow: Inputs tab → *Recovery*: `off` | `triage` (default `triage` when the flow has agent
blocks, else `off`); agent / model like the overseer). For `error` failures — and for any cause once its automatic
retries are used up — a triage agent (one run on this machine, read-only tools allowed in the run's worktree: Read,
Grep, Glob, git log/diff) gets: the node's task, its inputs (trimmed), the failure, the last ~200 log/activity lines,
the node's recovery history, and the flow around it (what feeds it, what it feeds). It writes a decision JSON (validated
like MEOW's `decision-<task>-<cycle>.json`):

```json
{"action": "retry" | "resume" | "rescope" | "skip" | "blocked", "reason": "…", "notes": "…", "task": "…", "output": "…"}
```

- `retry`: run the node again as it is (agent: fresh session).
- `resume`: run it again with `notes` appended to its instructions for this run (agent: continue the session with the
  notes) — MEOW appends "triage notes" to the plan.
- `rescope`: run it again with `task` replacing its input artifact for this run (a smaller / clearer task).
- `skip`: don't run it again; continue the flow as if it finished with `output` as its artifact (only when the node
  isn't a delivery step — Create MR / push / post comment are never skipped).
- `blocked`: needs a human → `hold` with the reason; the run pauses (part 1), watchers and the Run tab show why, and
  Continue retries the node.

**Budget and guards** (MEOW): each node has `recovery.cycles`; every retry / resume / rescope / skip decision costs one.
`maxRecoveryCycles` (default 3, flow setting) → beyond it the run is held as `recovery-exhausted`. The budget is per
node *per run* and survives continues (it's journaled). A triage decision identical to the previous one for the same
node (same action + same notes/task) → held as `repeated-decision`. Invalid / missing decision → held as
`invalid-decision`. Triage agent crash → held as `triage-failed`. Recovery never retries a node in a run that's being
stopped or paused.

**Journal + events**: `run.recovery[nodeKey] = {cycles, history: [{at, cause, message, decision, by: "auto" | "triage",
reason?, notes?}]}`; watchers get `{type: "recovery", node, cause, decision, reason}` events; the Run tab shows the
history under the node and the hold reason with Continue / Stop.

**Box Stack**: tasks keep their own retry (`maxRetries`); inside a task's flow, recovery applies like any run. A stack's
split/combine agent failures go through recovery like any node.

## Testing

- Supervisor: fake clock; silent → flag once; stuck → stopNode → failure cause `stuck`; timeout per block and node
  override; shell default 30 min; loop warning; reminder repeat bound; vanished container → `sandbox`; lock heartbeat;
  overseer: ok / steer / restart / invalid JSON / limits / identical steer suppressed (fake agent runner);
  supervision events visible to `watch_run`.
- Recovery: crash / transient / sandbox / stuck / timeout retried with backoff up to maxRetries then triaged; `error`
  goes straight to triage; triage actions retry / resume (notes reach the agent) / rescope / skip (refused on delivery
  steps) / blocked → hold; budget exhausted; repeated / invalid decision; triage crash; recovery off → fails as today;
  budget survives a continue (part 1); agent resume on first retry, fresh on the second.
