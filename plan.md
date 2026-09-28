# Sandflow — Implementation Plan

A visual (n8n-style) flow builder for coding-agent pipelines. Flows are made of **blocks** — deterministic **auto** logic, **AI** agent steps, and **manager** routers — wired together on a canvas. AI blocks run inside sandboxes via **`@ai-hero/sandcastle`**.

Stack: **React 19 + Vite + Tailwind v4 + shadcn/ui + @xyflow/react (React Flow v12) + zustand** (UI), **Express 5 + tsx** (server/flow engine), **@ai-hero/sandcastle** (agent runs).

---

## 0. Status (what already exists in this folder)

| File | State |
|---|---|
| `package.json` | Done. Scripts: `dev` (server + vite via concurrently), `dev:server`, `dev:web`, `build`, `start`, `typecheck` |
| `tsconfig.json` | Done. Single config for `src/`, `server/`, `shared/`; `@/*` → `src/*` |
| `vite.config.ts` | Done. React + Tailwind plugins, `@` alias, `/api` proxied to `http://localhost:3001` |
| `index.html` | Done (`<html class="dark">`) |
| `components.json` | Done (shadcn config: new-york, neutral, css vars, lucide) |
| `.gitignore` | Done (ignores `.sandflow/env.json`, `.sandflow/runs`) |
| `shared/types.ts` | Done. All domain types (see §2) |
| `shared/resolve.ts` | Done. Template resolution, flow requirements, helpers (see §3) |

**Everything else below is still TODO.**

> ⚠️ Security: `@ai-hero/sandcastle` 0.2.0–0.5.3 has a command-injection advisory (AIKIDO-2026-10637: attacker-controlled `promptArgs` can be executed as shell via `!command` expansion in prompt files). `package.json` pins `>=0.5.4`. **Never use `promptFile`/`promptArgs`** — always build prompts as inline `prompt` strings (inline prompts get no substitution/expansion).

---

## 1. Core concepts (requirements from the user)

- **Flow** = nodes + edges on a visual canvas (like n8n).
- **Block kinds**: `auto` (normal deterministic logic on host), `ai` (agent in sandbox), `manager` (AI router).
- **Inputs** a block may accept (none required, any subset):
  1. `artifact` — via edge
  2. `steer` (steer prompt) — via edge
  3. `startingPrompt` — **global** (one per app, in Settings)
  4. `env` — **global** env vars; a block declares the *names* it needs
- **Outputs** a block may produce (any subset): `artifact`, `steer`.
- **Side panel (Inputs tab)**: for the current flow, list — in a scrollable panel — the starting prompt (if any node needs it) and **every env var needed by any node** (with which nodes need it). Missing values are highlighted; **Run is disabled until all are filled**.
- **Template blocks**: a block marked `isTemplate` holds base config. Any block **or other template** can `extends` a template. Multi-level chains; cycles rejected.
- **Allow questions**: a switch on each block (and on the canvas node itself). When on, the agent may ask a question; the flow pauses (`waiting`) until the user answers in the UI, then the agent continues.
- **Manager block**: sits between one block and 2+ targets; an agent reads the incoming artifact/steer and picks **exactly one** outgoing connection (e.g. CR with no requested changes → Create MR, otherwise → CR Fix).
- **Every block has recommended online skills** installed into the sandbox before it runs.

### Built-in blocks
- **Create task** (auto): takes starting prompt + `BRANCH_NAME`, creates the branch, continues.
- **Plan** (ai)
- **Implement** (ai)
- **CR** (ai) — code review
- **CR fix** (ai)
- **Create MR** (auto)
- **Manager** (manager)

---

## 2. Data model (`shared/types.ts` — DONE)

Key types:
- `BlockConfig` — all-optional partial config: `kind, description, color, icon, inputs{artifact,steer,startingPrompt}, outputs{artifact,steer}, env[], allowQuestions, skills: SkillRef[], instructions, extraInstructions, autoAction ('create-task'|'create-mr'|'shell'), shellCommand, agent{provider,model,effort}, maxIterations`.
- `BlockDef { id, name, isTemplate, extends?, builtin?, config }`.
- `ResolvedConfig` — fully-populated config.
- `SkillRef { name, source ('owner/repo'), url?, why? }`.
- `FlowNode { id, type:'block', position, data: { blockId, label?, overrides?: BlockConfig } }`.
- `FlowEdge { id, source, target, sourceHandle: 'artifact'|'steer', targetHandle: 'artifact'|'steer' }`.
- `Flow { id, name, nodes, edges }`.
- `Settings { startingPrompt, sandbox: 'docker'|'podman'|'none', maxSteps }`.
- `AppData { blocks, flows, settings, env }`.
- Run types: `RunState { id, flowId, flowName, status, startedAt, finishedAt?, branch?, nodes: Record<id, NodeRunState>, pendingQuestion?, logs: LogLine[], error? }`, `NodeRunState { status, executions, inputs?, outputs?, error?, routedTo? }`.

## 3. Resolution (`shared/resolve.ts` — DONE)

- `DEFAULT_CONFIG` (agent default: `claudeCode`, `claude-opus-4-8`, effort `high`).
- `applyConfig(base, patch)`: scalars override; `inputs/outputs/agent` shallow-merge; **`env` and `skills` are unioned** down the chain; `extraInstructions` concatenated.
- `templateChain(id, blocks)` root-first, throws on cycle; `resolveBlock(id, blocks, overrides)`; `resolveNode(node, blocks)`; `resolveInherited(block, blocks)` (for "inherited" hints in the editor); `wouldCycle(blockId, parentId, blocks)`.
- `flowRequirements(flow, blocks)` → `{ env: [{name, nodes:[{id,label}]}], startingPromptNodes }` — drives the Inputs side panel.
- `nodeLabel`, `isSecretName` (mask inputs as password), `ENV_NAME_RE`.

---

## 4. Built-in library — `shared/library.ts` (TODO)

Export `BUILTIN_BLOCKS: BlockDef[]` and `DEFAULT_FLOW: Flow`.

### Templates
| id | name | extends | config |
|---|---|---|---|
| `tpl-ai-agent` | AI Agent (template) | – | kind `ai`; inputs artifact+steer+startingPrompt; outputs artifact+steer; env `REPO_PATH`, `ANTHROPIC_API_KEY`; agent claudeCode/claude-opus-4-8/high |
| `tpl-auto-git` | Git Automation (template) | – | kind `auto`; env `REPO_PATH` |
| `tpl-reviewer` | Reviewer (template) | `tpl-ai-agent` | *(demonstrates template-of-template)* base review instructions; skill `requesting-code-review` |

### Blocks + recommended skills
Skills install with `npx -y skills@latest add <source> --skill <name> -g -a <agent> -y` (vercel-labs/skills CLI; `-g` installs to the sandbox user dir so the repo stays clean).

| id | name | extends | kind / action | inputs → outputs | extra env | skills (source) |
|---|---|---|---|---|---|---|
| `create-task` | Create task | `tpl-auto-git` | auto / `create-task` | startingPrompt → artifact | `BRANCH_NAME`, `BASE_BRANCH` | `using-git-worktrees` (obra/superpowers) *(reference)* |
| `plan` | Plan | `tpl-ai-agent` | ai | artifact, steer, startingPrompt → artifact(plan), steer | – | `writing-plans`, `brainstorming` (obra/superpowers) |
| `implement` | Implement | `tpl-ai-agent` | ai, `maxIterations: 5` | → artifact(summary), steer | – | `executing-plans`, `test-driven-development` (obra/superpowers); `tdd` (mattpocock/skills) |
| `cr` | CR | `tpl-reviewer` | ai | → artifact(review + verdict), steer(fix instructions) | – | `requesting-code-review` (obra/superpowers); `code-review` (mattpocock/skills) |
| `cr-fix` | CR fix | `tpl-ai-agent` | ai, `maxIterations: 3` | → artifact, steer | – | `receiving-code-review` (obra/superpowers) |
| `create-mr` | Create MR | `tpl-auto-git` | auto / `create-mr` | artifact → artifact(MR URL) | `MR_PROVIDER` (`github`\|`gitlab`), `BASE_BRANCH`, `BRANCH_NAME` | `finishing-a-development-branch` (obra/superpowers) *(reference)* |
| `manager` | Manager | `tpl-ai-agent` | manager | artifact, steer, startingPrompt → artifact(passthrough), steer | – | `verification-before-completion` (obra/superpowers) |
| `shell` | Shell command | `tpl-auto-git` | auto / `shell` | artifact → artifact(stdout) | – | – |

Skill URLs: `https://github.com/obra/superpowers/tree/main/skills/<name>`, `https://github.com/mattpocock/skills`.

Instruction sketches (put real prompts in `instructions`):
- **Plan**: read task + repo, produce a step-by-step implementation plan (files, tests, risks) as the artifact; steer = key guidance for the implementer. Don't write code.
- **Implement**: follow the plan artifact + steer; TDD; commit work; artifact = summary of changes; emit `<promise>COMPLETE</promise>` when done.
- **CR**: review the diff vs `BASE_BRANCH` (`git diff origin/<base>...HEAD`) against the plan; artifact = review ending with `VERDICT: APPROVED` or `VERDICT: CHANGES_REQUESTED`; steer = concrete fix list.
- **CR fix**: apply the review's requested changes; commit; artifact = what was fixed.
- **Manager**: choose the best route given the routes list; default guidance: approved/no changes → Create MR, otherwise → CR fix.

### Default flow ("Feature pipeline")
```
Create task ─artifact→ Plan ─artifact+steer→ Implement ─artifact→ CR ─artifact+steer→ Manager
Manager ─artifact+steer→ CR fix ─artifact→ CR      (loop)
Manager ─artifact→ Create MR
```
Lay nodes out left→right (x step ~320), put CR fix below the Manager→Create MR line.

---

## 5. Server (TODO) — `server/`

### `server/storage.ts`
- Data dir: `./.sandflow/` (relative to cwd).
- `library.json` (blocks), `flows.json`, `settings.json`, `env.json` (**values, gitignored**), `runs/<runId>.json` (+ artifacts `runs/<runId>/<nodeId>-<n>.md`).
- On first load: seed `BUILTIN_BLOCKS`, `[DEFAULT_FLOW]`, default settings `{ startingPrompt: "", sandbox: "docker", maxSteps: 40 }`. On later loads, add any missing builtins by id (don't overwrite user edits).
- Atomic writes (write tmp + rename).

### `server/index.ts` (Express 5, port 3001, `express.json({limit:'5mb'})`)
- `GET  /api/data` → `AppData`
- `PUT  /api/blocks` (whole list; validate no template cycles, unique ids, template `extends` must point to a template)
- `PUT  /api/flows` (whole list)
- `PUT  /api/settings`, `PUT /api/env` (validate names with `ENV_NAME_RE`)
- `POST /api/runs { flowId }` → validates requirements (all env present, starting prompt non-empty if needed) → `{ runId }`; `400` with list of missing items otherwise
- `GET  /api/runs/:id` → `RunState`
- `GET  /api/runs/:id/events` → **SSE**; send full `RunState` snapshot on connect and on each change (`event: state`), heartbeat every 15s
- `POST /api/runs/:id/answer { answer }` → resolves pending question
- `POST /api/runs/:id/cancel` → AbortController.abort()
- In production (`npm start`) also serve `dist/` statically.

### `server/engine.ts` — flow execution
Run context: `{ run: RunState, flow, blocks, env, settings, branch?, sandbox? (lazy), abort: AbortController, installedSkills: Set<string>, emit() }`.

Algorithm (token passing, supports loops):
```
starts = nodes with no incoming edges (error if none)
queue = starts.map(n => ({ nodeId: n.id, inputs: {} }))
steps = 0
while queue not empty:
  if aborted → cancelled
  if ++steps > settings.maxSteps → fail("max steps exceeded — loop?")
  { nodeId, inputs } = queue.shift()
  cfg = resolveNode(node, blocks)
  outputs = await runNode(node, cfg, inputs)      // auto | ai | manager
  mask outputs to cfg.outputs (drop kinds the block doesn't emit)
  successors = unique targets of edges from node
  if cfg.kind == 'manager': targets = [chosen route] (must be one of successors)
  else: targets = successors (fan-out, processed in queue order)
  for t in targets: build t's inputs from **only the edges node→t**:
      for edge(node→t): tInputs[edge.targetHandle] = outputs[edge.sourceHandle]
    (only keep kinds t accepts: cfg(t).inputs.artifact / .steer)
    queue.push({ nodeId: t, inputs: tInputs })
finally: close sandbox (`await sandbox.close()`), persist run, status done/failed/cancelled
```
Update `run.nodes[id]` (status, executions++, inputs, outputs, routedTo, error), append logs, `emit()` after each change. Save artifacts to disk.

Node env for a block = only the env vars that block declares (`cfg.env`) — don't leak all globals.

### `server/runners/auto.ts` — host-side logic (use `execFile`, **no shell**, except `shell` action)
- **create-task**: `repo = env.REPO_PATH`, `branch = env.BRANCH_NAME`, `base = env.BASE_BRANCH || 'main'`.
  - validate: `git check-ref-format --branch <branch>`
  - if `git rev-parse --verify --quiet refs/heads/<branch>` exists → reuse; else `git branch <branch> <base>` (do **not** checkout — sandcastle creates a worktree for it and a checked-out branch can't get a worktree).
  - set `ctx.branch = branch`; artifact = `# Task\n\n<startingPrompt>\n\nBranch: <branch> (from <base>)`.
- **create-mr**: `git push -u origin <branch>` (cwd repo). Title = first markdown heading/line of starting prompt (≤72 chars); body = incoming artifact + run summary.
  - `github`: `gh pr create --head <branch> --base <base> --title <t> --body <b>`
  - `gitlab`: `glab mr create --source-branch <branch> --target-branch <base> --title <t> --description <b> --yes`
  - artifact = CLI stdout (MR URL).
- **shell**: `spawn(cmd, { shell: true, cwd: repo, env: {...process.env, ...blockEnv, SANDFLOW_ARTIFACT, SANDFLOW_STEER} })`; artifact = stdout; non-zero exit = fail.

### `server/runners/ai.ts` — sandcastle
```ts
import * as sc from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { podman } from "@ai-hero/sandcastle/sandboxes/podman";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
```
- **Agent factory**: `(sc as any)[cfg.agent.provider](cfg.agent.model, { effort, env: blockEnv })` (claudeCode/codex/pi/opencode/cursor/copilot). Throw a clear error if the export is missing. Agent `env` and sandbox `env` must not overlap — only pass env on the agent.
- **Lazy shared sandbox per run** (so all AI blocks work on the same branch/worktree):
  ```ts
  ctx.sandbox ??= await sc.createSandbox({
    branch: ctx.branch ?? env.BRANCH_NAME ?? `sandflow/${runId}`,
    sandbox: provider(settings.sandbox),   // docker() | podman() | noSandbox()
    cwd: env.REPO_PATH,
    hooks: { sandbox: { onSandboxReady: [{ command: "npm install" }] } } // optional; make configurable later
  });
  ```
- **Skills**: before each AI/manager block, for each skill not in `ctx.installedSkills`: validate `source` matches `/^[\w.-]+\/[\w.-]+$/` and `name` matches `/^[\w.-]+$/`, then `await ctx.sandbox.exec(\`npx -y skills@latest add ${source} --skill ${name} -g -a ${agentFlag} -y\`)`. `exec` returns non-zero rather than throwing → log a warning, continue. Agent flag map: claudeCode→`claude-code`, codex→`codex`, opencode→`opencode`, cursor→`cursor`, copilot→`github-copilot` (omit `-a` for unknown).
- **Prompt builder** (`server/prompt.ts`), inline string:
  ```
  # Role
  <instructions>\n<extraInstructions>
  # Skills
  Use these installed skills where relevant: <name — why>…
  # Task (starting prompt)            ← only if inputs.startingPrompt
  # Steering from previous step       ← only if steer input present
  # Input artifact                    ← only if artifact input present
  # Previous Q&A                      ← if any
  # Output protocol
  - Put your main deliverable inside <artifact>…</artifact>        (only if outputs.artifact)
  - Put instructions for the next step inside <steer>…</steer>     (only if outputs.steer)
  - (allowQuestions) If you truly need info from the user, output ONLY <question>…</question> and stop.
  - (maxIterations>1) When fully done output <promise>COMPLETE</promise>.
  ```
- **Run**: `const res = await ctx.sandbox.run({ agent, prompt, maxIterations: cfg.maxIterations, name: nodeLabel, signal: ctx.abort.signal })`. Stream nothing fancy; after run, log `res.stdout` tail + `res.commits.length` + token usage from `res.iterations[i].usage`.
- **Parse** `res.stdout`: take the **last** match of `<artifact>`, `<steer>`, `<question>`, `<route>`. If no `<artifact>` tag but block outputs artifact, fall back to the stdout tail.
- **Questions loop** (if `cfg.allowQuestions` and `<question>` found, max 5 rounds): set node + run status `waiting`, `run.pendingQuestion = {nodeId, question}`, emit, `await waitForAnswer(runId)` (Promise resolved by `/answer`, rejected on cancel). Then continue with `res.resume?.(answerPrompt)` if available, else re-run with the Q&A appended to the prompt. If allowQuestions is off, ignore the tag.
- **Manager**: prompt additionally lists routes: for each outgoing target → `id`, label, block description, and which handles are wired. Ask for `<route>TARGET_ID</route>` + optional `<steer>`. If the id is invalid → retry once, then fall back to the first target and log a warning. Manager outputs: artifact = passthrough of incoming artifact; steer = its own steer if given, else passthrough.

---

## 6. UI (TODO) — `src/`

### Base
- `src/main.tsx`, `src/index.css` (Tailwind v4: `@import "tailwindcss"; @import "tw-animate-css"; @custom-variant dark (&:is(.dark *));` + shadcn neutral CSS variables for `:root` and `.dark` + `@theme inline` mapping), `src/lib/utils.ts` (`cn`).
- shadcn components in `src/components/ui/`: `button, input, textarea, label, switch, badge, card, scroll-area, select, dialog, tabs, separator` (standard shadcn new-york source, Radix packages already in package.json).
- `src/lib/api.ts` — fetch wrappers + `subscribeRun(runId, onState)` using `EventSource`.
- `src/lib/store.ts` — zustand: `data: AppData`, `currentFlowId`, `selectedNodeId`, `editingBlockId`, `run?: RunState`, actions (CRUD blocks/templates/flows/nodes/edges, settings, env), **debounced (500ms) persistence** to the PUT endpoints, save status indicator.

### Layout (`src/App.tsx`)
```
┌ Top bar: logo · flow <Select> · New / Rename / Delete flow · save status · Settings · ▶ Run / ■ Cancel ┐
├ Left 260px: Palette ─┬─ Center: React Flow canvas ─┬─ Right 360px: Side panel (Tabs) ┤
│  Tabs: Blocks|Templates│  (Background, Controls,    │  Inputs | Block | Run            │
│  drag onto canvas      │   MiniMap, colorMode dark)  │                                   │
│  + New block/template  │                             │                                   │
└────────────────────────┴─────────────────────────────┴───────────────────────────────────┘
```

### Palette (`components/Palette.tsx`)
- Two tabs: **Blocks** / **Templates**. Each item: color dot, icon, name, kind badge, "extends X" hint. Draggable (`dataTransfer.setData('application/sandflow-block', id)`); click → open Block Editor.
- Buttons: **New block**, **New template** (both open editor; a new block can pick any template to extend; a new template can also extend a template).
- Templates can also be dropped on the canvas (they're usable blocks too) — show a subtle "template" badge.

### Canvas (`components/FlowCanvas.tsx`)
- `ReactFlow` with `nodeTypes={{ block: BlockNode }}`, `onDrop` (screenToFlowPosition), `onConnect` (only artifact→artifact/steer, steer→artifact/steer; reject if target doesn't accept that input; allow multiple outgoing edges), delete with Backspace, `fitView`.
- Edge styling by `sourceHandle`: artifact = solid blue, steer = dashed amber; animated while the source node is running; edge from a manager into its chosen route highlighted after a run.

### Block node (`components/BlockNode.tsx`)
- Header with block color + lucide icon + label + kind badge (AUTO / AI / MANAGER); "tpl" badge if template; "extends X".
- Left target handles (only those enabled): `artifact`, `steer` with small labels. Right source handles: `artifact`, `steer`.
- Chips row showing global inputs used: "starting prompt", env count (tooltip/list of names).
- Skills chips (first 2 + "+n").
- **Allow questions `Switch`** directly on the node (writes `overrides.allowQuestions`) — only for ai/manager.
- Run status ring/badge: queued/running(spinner)/waiting(pulse, "?")/done(✓)/failed(✗) + execution count ×n.

### Side panel (`components/SidePanel.tsx`, tabs)
1. **Inputs** (default tab) — `components/InputsPanel.tsx`, inside `ScrollArea`:
   - Starting prompt `Textarea` (shown if any node needs it; list the nodes that use it).
   - One row per required env var from `flowRequirements`: name, `Input` (password for `isSecretName`), "used by: Plan, CR…" chips, red border if empty. Values write to global env.
   - Footer: "All inputs ready ✓" or "N missing" — this gates the **Run** button.
   - Collapsible "Other global env vars" (set but not used by this flow) + "Add env var".
2. **Block** — selected node: label, allow-questions switch, extra instructions (node override), resolved read-only summary (inputs/outputs/env/skills with links/agent/instructions preview), **Edit block definition** button (opens editor), **Duplicate as new block**, delete node.
3. **Run** — `components/RunPanel.tsx`: status, branch, per-node list (status, executions, routedTo), click a node → its latest inputs/outputs (artifact/steer shown in `<pre>`), logs stream (auto-scroll). When `pendingQuestion` → prominent card with the question + `Textarea` + **Send answer** (also open `QuestionDialog` automatically).

### Block Editor (`components/BlockEditor.tsx`, `Dialog`, large, scrollable)
- Name, **Is template** switch, **Extends** `Select` (templates only, excluding self & descendants via `wouldCycle`), kind, description, color, icon.
- For every field show the inherited value (from `resolveInherited`) as placeholder/hint, with a ↺ "reset to inherited" button when the block overrides it (i.e. field set in `config`).
- Inputs toggles (artifact, steer, starting prompt), Outputs toggles (artifact, steer).
- Env var names (chip input, validated by `ENV_NAME_RE`; inherited ones shown as locked chips).
- Allow questions switch.
- Skills list: name / source / url / why; inherited skills shown read-only; **"Add recommended"** menu with the catalog from §4.
- AI/manager: instructions `Textarea`, agent provider `Select`, model `Input`, effort `Select`, maxIterations.
- Auto: action `Select` (create-task / create-mr / shell); shell command textarea for `shell`.
- Footer: Delete (disabled for blocks used in flows or templates extended by others — show where), Cancel, Save.

### Settings dialog
Sandbox provider (docker / podman / none), max steps, starting prompt (same value as Inputs panel).

---

## 7. Build order for the next session

1. `shared/library.ts` (builtins + default flow + skills catalog).
2. `server/storage.ts`, `server/prompt.ts`, `server/runners/auto.ts`, `server/runners/ai.ts`, `server/engine.ts`, `server/index.ts`.
3. `src/index.css`, `src/lib/*`, shadcn `ui/*`.
4. `BlockNode`, `FlowCanvas`, `Palette`, `InputsPanel`, `SidePanel`/`RunPanel`, `BlockEditor`, `SettingsDialog`, `QuestionDialog`, `App.tsx`, `main.tsx`.
5. `README.md`: prerequisites (Node 22+, Docker Desktop running, `npx @ai-hero/sandcastle init` + `npx @ai-hero/sandcastle docker build-image` inside the **target repo**, `gh`/`glab` authenticated for Create MR), `npm install`, `npm run dev`, open http://localhost:5173.
6. `npm run typecheck`, fix errors, then smoke-test: run the default flow against a throwaway git repo with `sandbox: none` first, then docker.

## 8. Notes / open questions
- Windows: sandcastle uses git worktrees + Docker; if paths misbehave on Windows, run the server under WSL.
- `createSandbox` accepting `cwd` and `SandboxRunResult.resume` existing should be verified against the installed sandcastle version's `.d.ts`; fall back to `createWorktree({ branchStrategy:{type:'branch',branch}, cwd }).createSandbox(...)` if `cwd` isn't accepted, and to re-run-with-Q&A if `resume` is missing.
- Docs: https://github.com/mattpocock/sandcastle · skills CLI: https://github.com/vercel-labs/skills · superpowers skills: https://github.com/obra/superpowers · Matt Pocock skills: https://github.com/mattpocock/skills
