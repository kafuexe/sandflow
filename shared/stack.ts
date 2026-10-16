// Box Stack: an orchestrator splits the input into tasks, one child flow runs per task (several at once), and the
// orchestrator combines what came back into one output.

/** A stack node's exits, whatever its child flow looks like. */
export const STACK_EXITS = ["done", "failed"];

export const DEFAULT_SPLIT =
  "Split the input into independent tasks that can be worked on in parallel without stepping on each other. " +
  "Give each task a short name and a self-contained input: everything someone needs to do that task alone.";

export const DEFAULT_COMBINE =
  "Combine these results into one output for the next step. Keep what each task did, call out anything that " +
  "conflicts or is missing, and list tasks that were dropped.";

/** Appended to the split instructions so the orchestrator answers in a form the stack can read. */
export const SPLIT_PROTOCOL =
  'Reply with one JSON object and nothing else: {"tasks": [{"name": "<short name>", "input": "<everything the task needs>"}]}';

export interface SplitTask {
  name: string;
  input: string;
}

/** The task list in an orchestrator's split answer: a JSON object, bare or in a ``` fence, anywhere in the text. */
export function parseSplit(text: string): { tasks: SplitTask[] } | { error: string } {
  const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/i.exec(text)?.[1];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const raw = fenced ?? (start >= 0 && end > start ? text.slice(start, end + 1) : undefined);
  if (!raw) return { error: "There's no JSON object in the answer." };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { error: `The JSON doesn't parse: ${(e as Error).message}` };
  }
  const tasks = (data as { tasks?: unknown })?.tasks;
  if (!Array.isArray(tasks)) return { error: '"tasks" must be a list.' };
  const out: SplitTask[] = [];
  for (const [i, t] of tasks.entries()) {
    const x = t as { name?: unknown; input?: unknown };
    if (typeof x?.input !== "string" || !x.input.trim()) return { error: `task ${i + 1} has no "input".` };
    out.push({ name: typeof x.name === "string" ? x.name : "", input: x.input });
  }
  return { tasks: out };
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/, "");

/** Unique, non-empty task names, each with a slug that's safe in a branch name. */
export function normaliseTasks(tasks: SplitTask[]): (SplitTask & { slug: string })[] {
  const seen = new Set<string>();
  return tasks.map((t, i) => {
    const base = t.name.trim() || `task-${i + 1}`;
    let name = base;
    for (let k = 2; seen.has(name.toLowerCase()); k++) name = `${base}-${k}`;
    seen.add(name.toLowerCase());
    return { name, slug: slugify(name) || `task-${i + 1}`, input: t.input };
  });
}
