import fs from "node:fs";
import { describe, expect, it } from "vitest";
import * as sc from "@ai-hero/sandcastle";
import { CLI_DEFAULT_MODEL, withoutModelFlag } from "../backend/runners/ai";
import { BUILTIN_BLOCKS } from "../shared/library";
import { resolveBlock } from "../shared/resolve";

type Built = { buildPrintCommand: (o: object) => { command: string }; buildInteractiveArgs?: (o: object) => string[] };
const factories = sc as unknown as Record<string, (model: string, opts?: object) => Built>;
const PROVIDERS = ["claudeCode", "codex", "pi", "opencode", "cursor", "copilot"];

describe("no model set = the agent CLI's default model", () => {
  it("Sandflow's default and the AI Agent template set no model", () => {
    const tpl = BUILTIN_BLOCKS.find((b) => b.id === "tpl-ai-agent");
    expect(tpl?.config.agent?.model).toBeUndefined();
    expect(resolveBlock("tpl-ai-agent", BUILTIN_BLOCKS).agent.model).toBe("");
    const packTpl = JSON.parse(fs.readFileSync("packs/base/boxes/tpl-ai-agent.json", "utf8"));
    expect(packTpl.config.agent.model).toBeUndefined();
  });

  it.each(PROVIDERS)("%s: the model flag is left out, everything else kept", (p) => {
    const agent = withoutModelFlag(factories[p](CLI_DEFAULT_MODEL, { effort: "high" }) as never) as Built;
    const cmd = agent.buildPrintCommand({ prompt: "hi", dangerouslySkipPermissions: true }).command;
    expect(cmd).not.toContain(CLI_DEFAULT_MODEL);
    expect(cmd).not.toMatch(/ (--model|-m)( |$)/);
    // Same command as with a real model, minus that model's flag.
    const withModel = factories[p]("my-model", { effort: "high" }).buildPrintCommand({ prompt: "hi", dangerouslySkipPermissions: true }).command;
    expect(withModel.replace(/ (?:--model|-m) 'my-model'/, "")).toBe(cmd);
    const args = agent.buildInteractiveArgs?.({ prompt: "hi" });
    if (args) expect(args).not.toContain(CLI_DEFAULT_MODEL);
  });
});
