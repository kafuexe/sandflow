import type { NodeIO, QaPair, ResolvedConfig } from "../shared/types";

export interface RouteOption {
  id: string;
  label: string;
  description: string;
  handles: string[];
}

export interface PromptParts {
  cfg: ResolvedConfig;
  inputs: NodeIO;
  startingPrompt: string;
  qa: QaPair[];
  /** manager only: the outgoing connections to choose from. */
  routes?: RouteOption[];
  /** Where the files of the pack this block comes from are (read-only), when it comes from one. */
  packDir?: string;
}

/** Builds the inline prompt string for an AI / manager block (never a prompt file — see plan §0). */
export function buildPrompt({ cfg, inputs, startingPrompt, qa, routes, packDir }: PromptParts): string {
  const sections: string[] = [];
  const role = [cfg.instructions, cfg.extraInstructions].filter((s) => s.trim()).join("\n\n");
  sections.push(`# Role\n${role || "You are a helpful software engineering agent."}`);

  if (cfg.skills.length) {
    const list = cfg.skills.map((s) => `- ${s.name}${s.why ? ` — ${s.why}` : ""}`).join("\n");
    sections.push(`# Skills\nUse these installed skills where relevant:\n${list}`);
  }
  if (packDir) {
    sections.push(`# Pack files\nFiles that come with this block (templates, checklists, scripts, …) are in \`${packDir}\` (also \`$PACK_DIR\`), read-only.`);
  }
  if (cfg.inputs.startingPrompt && startingPrompt.trim()) {
    sections.push(`# Task (starting prompt)\n${startingPrompt.trim()}`);
  }
  if (inputs.steer?.trim()) sections.push(`# Steering from previous step\n${inputs.steer.trim()}`);
  if (inputs.artifact?.trim()) sections.push(`# Input artifact\n${inputs.artifact.trim()}`);
  if (qa.length) {
    sections.push(
      `# Previous Q&A\n${qa.map((p) => `Q: ${p.question}\nA: ${p.answer}`).join("\n\n")}`,
    );
  }
  if (routes?.length) {
    const list = routes
      .map((r) => `- id: ${r.id} — ${r.label}${r.description ? ` (${r.description})` : ""}; receives: ${r.handles.join(", ")}`)
      .join("\n");
    sections.push(
      `# Routes\nChoose exactly ONE of these next steps:\n${list}\n\nOutput the chosen id as <route>ID</route>.`,
    );
  }

  const protocol: string[] = [];
  if (cfg.outputs.artifact) protocol.push("- Put your main deliverable inside <artifact>…</artifact>.");
  if (cfg.outputs.steer) protocol.push("- Put instructions for the next step inside <steer>…</steer>.");
  if (routes?.length) protocol.push("- Put the id of the chosen route inside <route>…</route>.");
  if (cfg.allowQuestions) {
    protocol.push("- If you truly need information from the user, output ONLY <question>…</question> and stop.");
  }
  if (cfg.maxIterations > 1) protocol.push("- When you are fully done, output <promise>COMPLETE</promise>.");
  if (protocol.length) sections.push(`# Output protocol\n${protocol.join("\n")}`);

  return sections.join("\n\n");
}

export interface ParsedOutput {
  artifact?: string;
  steer?: string;
  question?: string;
  route?: string;
}

function lastTag(text: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  let last: string | undefined;
  for (const m of text.matchAll(re)) last = m[1];
  return last?.trim();
}

export function parseOutput(stdout: string): ParsedOutput {
  return {
    artifact: lastTag(stdout, "artifact"),
    steer: lastTag(stdout, "steer"),
    question: lastTag(stdout, "question"),
    route: lastTag(stdout, "route"),
  };
}

export function tail(text: string, chars = 4000): string {
  return text.length > chars ? `…${text.slice(-chars)}` : text;
}
