// How to design Sandflow flows — the assistant's system prompt and the body of the agent skill
// (agent-skills/sandflow-flows/SKILL.md, kept in sync by test/flowGuide.test.ts).

export const FLOW_GUIDE = `## Model

A flow is a graph of **nodes**. Each node places a **block** from the library (\`list_blocks\`). Nodes are wired by
**edges** that carry one of two things:

- **artifact** — the main deliverable (a task, plan, summary, review, reply). Blue on the canvas.
- **steer** — short guidance for the next step ("fix these 3 things"). Dashed amber.

Block kinds:

- **trigger** — starts the flow (Manual start, Schedule, GitHub/GitLab event). Takes no inputs; outputs an artifact describing the event. Use at most one per start.
- **auto** — deterministic step on the host: Create task (makes the branch), Create MR, Shell command, Post comment.
- **ai** — an agent in a sandbox: Plan, Implement, CR, CR fix, Answer comment, or custom blocks.
- **manager** — an agent that sends the task down exactly ONE of its outgoing edges. Give it 2+ targets.
- **condition** (If) — deterministic rules; continues out of \`true\` or \`false\`. An unconnected branch ends that path.

Nodes with no incoming edge are start nodes. Loops are allowed (CR → Manager → CR fix → CR); the engine caps total steps.

## Edges

Write edges as \`source.handle -> target.handle\` using node ids, e.g. \`plan.artifact -> implement.artifact\`.
Handles default to artifact (\`plan -> implement\`). If blocks connect from \`check.true\` / \`check.false\`.
A source must output the handle and the target must accept it — \`list_blocks\` shows each block's \`in:\` and \`out:\`.
Wire both artifact and steer between agent steps when the block outputs both (plan → implement usually wants both).

## Working method

1. \`list_blocks\`, then \`get_flow\` to see what exists. Never guess block ids.
2. Pick short, readable node ids (\`plan\`, \`review\`, \`only-mine\`).
3. For a new design use \`replace_flow\` (or \`create_flow\`) with all nodes and edges in one call. For changes use \`edit_flow\` with a batch of ops. Layout is automatic — never send coordinates.
4. Read the validation in the tool result and fix every error before you finish.
5. Customise a node with \`overrides\` (e.g. \`extraInstructions\`, \`allowQuestions\`, an If block's \`condition\`) before creating new blocks. Only \`save_block\` when the library has nothing close; extend a template (\`tpl-ai-agent\`, \`tpl-auto-git\`, \`tpl-reviewer\`).
6. Finish with \`flow_requirements\` and tell the user which inputs to fill in. You can't set env values or run flows — the user does that.

## Condition overrides

\`{"condition": {"match": "all", "rules": [{"field": "trigger.author", "op": "equals", "value": "alice"}]}}\`
Fields: \`text\` (input artifact), \`steer\`, \`json.<path>\`, \`trigger.<path>\` (type, author, body, title, labels, branch…).
Ops: equals, not_equals, contains, not_contains, starts_with, ends_with, matches (regex), in (comma list), exists, not_exists, gt, lt, is_true, is_false.

## Common shapes

- Feature: Manual start or Create task → Plan → Implement → CR → Manager → (Create MR | CR fix → CR).
- Answer comments: GitLab/GitHub trigger → If (author/keyword) → Answer comment → Post comment.
- Scheduled job: Schedule → Shell command or an ai block.
`;
