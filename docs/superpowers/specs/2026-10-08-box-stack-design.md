# Box Stack, run flags and grouped run history — design

Date: 2026-10-08 · Branch: `feat/box-stack` (from `feat/packs`)

## Goal

Let a flow run **many subflows concurrently under an orchestrator agent and get one output back**. Example: a flow
writes a big plan → a Box Stack splits it into areas → each area runs an "explore → implement → CR" flow in parallel →
the stack combines the results → the parent flow continues to "CR everything → fix → loop → create MR".

Supporting this, runs gain **flags** (a saved, global "something went wrong" state), an **alert popup**, and the Agent
run list shows **stack children grouped under their parent run**.

## Decisions

| Topic | Decision |
|---|---|
| Orchestrator shape | Two fixed agent calls: **split** (input → task list) and **combine** (successful results → one output) |
| Children | N runs of **one** child flow, one per task |
| Workspace | Configurable per stack: **Shared** (parent sandbox) or **Isolated** (worktree + branch per child). Who merges is up to the flow designer |
| Concurrency | `maxConcurrent` limits running children; `maxChildren` caps the split |
| Failure | A child is **rejected** on a non-success exit or an error; retried up to `maxRetries`; then **dropped** |
| Partial result | Combine runs on the successful children; stack exits `done`; a **warning flag** names the dropped ones. `failed` only when nothing succeeded or split/combine failed |
| History | Extend the existing Agent-screen run list (no new view). Stack children are their own runs, grouped under the parent |
| Alerts | In-app popup on every flag event, native OS notification when the window is unfocused |

## Build order

1. Run flags + alert popup + "Flagged" group (useful alone: failed runs get flagged).
2. Child-run model + grouped run list.
3. Box Stack block: config, engine, workspace modes, merge lock, canvas node.

---

## Part 1 — Run flags and alerts

### Model (`shared/types.ts`)

```ts
export type FlagSeverity = "warning" | "error";
export interface RunFlag {
  id: string;
  severity: FlagSeverity;
  /** Node key that raised it (`stack1`, `stack1/cr`), if any. */
  nodeKey?: string;
  message: string;
  /** Longer text shown when the flag is expanded (e.g. each dropped area and its last reason). */
  details?: string;
  /** Set when the flag was copied up from a child run. */
  fromRunId?: string;
  at: number;
  dismissed?: boolean;
}
```

`RunState.flags?: RunFlag[]`. `RunSummary` gets `flags?: { warning: number; error: number }` counting **undismissed**
flags (computed in `summarize`).

### Raising flags (backend)

- The engine context gets `flag(severity, message, opts?: { nodeKey?, details? })`. It appends to `run.flags`, saves the
  run immediately and broadcasts `{ type: "flag", runId, flag }` on the existing `/api/data/events` stream.
- A flag on a child run is also appended to its parent run (with `fromRunId`), recursively up to the top-level run.
- Sources:
  - **Engine:** a run that ends `failed` gets an `error` flag with the run's error.
  - **Box Stack:** see Part 3.
  - **Flows:** Script blocks get a `flag(severity, message, details?)` helper so any flow can raise one.
- API: `POST /runs/:id/flags/:flagId/dismiss` sets `dismissed: true`, saves, and broadcasts `{ type: "flag-dismissed" }`.

### Alert popup (frontend)

A small `FlagAlerts` component mounted once in `App.tsx` (shown in both Builder and Agent views); no new library.

- Bottom-right, up to 3 stacked, newest on top; an overflow line "+2 more flags" opens the Agent view filtered to Flagged.
- Content: flag icon, run title, the message (clamped to 3 lines), buttons **Dismiss** and **Open run**.
- Left edge stripe: orange for `warning`, red for `error`.
- Warnings auto-dismiss after 10 s (timer paused on hover/focus); errors stay until acted on.
- **Open run** switches to the Agent view and selects the run. **Dismiss** closes the popup only — the flag stays on
  the run until cleared in the run view.
- `role="status"` for warnings, `role="alert"` for errors; keyboard reachable; slide-in disabled under
  `prefers-reduced-motion`.
- When the Electron window is not focused, also show a native notification (via the preload bridge); clicking it focuses
  the window and opens the run.

### Run list and run view

- New tone in `status.tsx`: `flagged` → orange (`text-orange-300`, `bg-orange-400`), `Flag` icon. Amber stays "needs
  your answer", red stays "failed".
- New top group **Flagged** (above "Needs your answer") with top-level runs that have undismissed flags. A run may also
  appear in Running while flagged; it is listed under Flagged only once finished.
- Run detail view: a flags banner at the top of the conversation — one line per undismissed flag with message, source
  node (click scrolls to that step) and **Clear**; expand shows `details`. Clearing every flag removes the run from
  Flagged. Cleared flags stay in the run file with `dismissed: true`.

---

## Part 2 — Child runs and the grouped run list

### Model

```ts
// RunState and RunSummary
parent?: { runId: string; nodeKey: string };
stack?: {
  groupId: string;   // one per stack execution (a looping parent gets a new group each time)
  name: string;      // stack node label
  index: number;     // task position from the split
  total: number;
  task: string;      // task name from the split
  attempt: number;   // 1-based
  outcome?: "succeeded" | "rejected" | "dropped";
  branch?: string;   // Isolated mode
};
```

- Every child attempt is a real run with its own `runs/<id>.json`, logs, detail view and flags.
- A retry is a new run with the same `groupId` + `index` and `attempt + 1`.
- `listRuns` returns top-level runs plus their children; the client groups them. Child runs never appear on their own in
  "Earlier".
- `settleInterrupted` also settles child runs; an interrupted parent with a running stack gets an `error` flag
  ("Interrupted while 3 of 7 areas were running"). Resuming a stack is out of scope.

### Run list UI (`src/components/agent/RunList.tsx`)

```
 Running                              3
   ◌  Big refactor: plan → MR        2m
   ┣━ Areas · 4 of 7 done   ▰▰▰▰▱▱▱
   ┃  ✓  auth
   ┃  ⟳  billing         attempt 2/3
   ┃  ✕  search          dropped
   ┃  ◌  ui-kit
```

- The parent row is followed by a **group header** per stack group: stack name, "n of N done", and a segmented bar
  (one segment per task, coloured with the run tones; dropped = orange).
- Child rows are indented under a thin vertical rail so the group reads as one unit. Only the latest attempt per index is
  listed; label = task name; secondary text = "attempt 2/3" while retrying, "dropped" when out of retries.
- Groups are collapsible: open while running, collapsed once finished; state remembered per group for the session.
- A child asking a question appears under "Needs your answer" as "Areas › billing asks: …"; only that child waits.
- Selecting a child opens its run with a breadcrumb back to the parent ("Big refactor › Areas › billing"). The child's
  run view lists earlier attempts behind an "Attempts" disclosure.

---

## Part 3 — The Box Stack block

### Block kind and config

`BlockKind` gains `"stack"`. Config (`BlockDef.stack` / `ResolvedConfig.stack`):

| Field | Default | Notes |
|---|---|---|
| `flowId` | — | Child flow; must have a Flow input |
| `successExits` | `["done"]` | Must be exits of the child flow. Anything else, or an error, = rejected |
| `workspace` | `"isolated"` | `"shared"` \| `"isolated"` |
| `maxConcurrent` | 3 | ≥ 1 |
| `maxChildren` | 12 | ≥ `maxConcurrent` |
| `maxRetries` | 1 | ≥ 0, per child |
| `agent` | — | Orchestrator `AgentConfig` (provider/model/effort/endpoint), plus skills, same editor as an AI block |
| `splitInstructions` | default text | "Split the input into independent tasks that can be done in parallel…" |
| `combineInstructions` | default text | "Combine these results into one output…" |

Interface on the canvas: one input (artifact + steer); exits `done` and `failed` (fixed, not derived from the child).

### Canvas node

Rendered like a subflow node with a stacked-card edge (two offset outlines behind the card). Body:
`<child flow> · ≤3 at once`. While running it shows the same segmented progress bar as the run list.

### Execution (`backend/engine.ts`)

1. **Snapshot** the child flow (and blocks) so every child runs the same version even if it's edited mid-run.
2. **Split.** Run the orchestrator (AI runner, parent sandbox) with the stack input and `splitInstructions`. Expected
   output: `{ "tasks": [{ "name": string, "input": string }] }`. Parsed like the manager's `route`: invalid JSON, or
   more than `maxChildren` tasks, re-asks with the problem stated (bounded attempts, then the stack fails).
   Names are normalised: empty → `task-<n>`, duplicates → `auth-2`; a sanitised slug is kept for branch names.
   Zero tasks → go straight to combine with an empty result list.
3. **Fan-out.** Queue all tasks; a pool of `maxConcurrent` workers takes from it. Each attempt:
   - creates a child run (Part 2) and runs the child graph from its Flow input with `{ artifact: task.input, steer:
     stack steer }`;
   - **Shared:** uses the parent run's sandbox;
   - **Isolated:** creates a sandbox via the same path as the run sandbox, on branch
     `<run-branch>-stack-<index>-<slug>` (not `/`-nested: git cannot hold both `a/b` and `a/b/c`) cut from the parent branch at stack start (suffix added if it exists); the
     branch is recorded on the child run.
4. **Retry.** A rejected attempt is re-queued with `attempt + 1`; its input is prefixed with the previous rejection
   ("Previous attempt ended at exit `rejected`: <reason>" or the error). After `maxRetries` it is **dropped**.
5. **Combine.** When every task has settled, run the orchestrator with the original input, `combineInstructions` and
   each **successful** child's outputs labelled by task name (Isolated: plus each branch name, so the instructions can
   say "merge these branches"). Its output leaves through `done`.
6. **Flags.** Any dropped child → `warning` flag: "2 of 7 areas dropped after retries: search, payments", details =
   each dropped task with its attempts and last reason. Nothing succeeded, split failed or combine failed → exit
   `failed` and an `error` flag (Isolated: details list the child branches so work isn't lost).

### Merge lock (Isolated + child merges itself)

A new auto-block action **"Merge into parent branch"** merges the current child branch into the branch the stack was
cut from. It holds a per-stack-execution mutex while merging, so concurrent children never race on the parent branch.
A merge conflict fails that node (and so rejects the attempt, which may be retried).

### Cancel and limits

- Cancelling the parent aborts all running children and drops the queue.
- A stack inside a child flow counts toward `MAX_SUBFLOW_DEPTH`; `subflowIds` / `subflowCycle` follow stack references
  too.

### Validation (`shared/validate.ts`)

Errors on: no child flow / unknown flow / child flow without a Flow input; `maxConcurrent < 1`;
`maxChildren < maxConcurrent`; `maxRetries < 0`; a success exit that isn't a child exit; a cycle through stacks.

---

## Testing (vitest)

- **Engine** (fake runners, `test/engine.test.ts` style): split → N children; observed peak concurrency ≤
  `maxConcurrent`; retry on non-success exit and on error, with the previous reason in the next input; drop after
  `maxRetries`, combine excludes dropped, warning flag raised; nothing succeeded → `failed` + error flag; invalid split
  JSON and too many tasks re-ask; parent cancel aborts children; child question doesn't block siblings; mid-run edit of
  the child flow doesn't affect running children.
- **Merge lock:** concurrent "Merge into parent branch" calls are serialised.
- **Storage:** child runs saved/listed with `parent`/`stack`; flags persisted and dismissed; flags copied to parents;
  `settleInterrupted` on parent and children.
- **Validation:** each rule above.
- **UI:** grouping and collapse in the run list; Flagged group membership and clearing; popup from the event stream,
  warning auto-dismiss vs. sticky error; Open run navigation. Plus a manual pass in the running app.

## Out of scope

Resuming an interrupted stack; per-task different child flows; an orchestrator that reacts to children as they finish
or starts more after combine; automatic merging by the stack itself.
