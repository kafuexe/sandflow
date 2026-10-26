// Every integration Sandflow knows: the ones packs bring (`integrations/*.json`) and your own, kept in
// `<data>/integrations.json`. Also answers "is the harness installed?" and loads an option's choices by running
// the harness — both run its executable on this machine, so only for trusted integrations.

import fs from "node:fs";
import path from "node:path";
import {
  actionOptions,
  LOCAL_INTEGRATIONS,
  integrationBlocks,
  integrationInfo,
  integrationProblems,
  parseChoices,
  parseVersion,
  renderTemplate,
  type TemplateVars,
} from "../shared/integrations";
import type { BlockDef, EnvValues, IntegrationChoice, IntegrationDef, IntegrationInfo, IntegrationStatus } from "../shared/types";
import type { PackStore } from "./packs";
import { blockedReason, runHarness } from "./runners/integration";

const STATUS_TTL = 60_000;
const CHECK_TIMEOUT_MS = 20_000;
const CHOICES_TIMEOUT_MS = 60_000;

/** Runs the harness for a check (swappable in tests). */
export type HarnessExec = typeof runHarness;

export type IntegrationStore = ReturnType<typeof createIntegrationStore>;

export function createIntegrationStore(dataDir: string, packs: PackStore, exec: HarnessExec = runHarness) {
  const file = path.join(dataDir, "integrations.json");
  const status = new Map<string, IntegrationStatus>();

  function readOwn(): IntegrationDef[] {
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      return Array.isArray(j) ? (j as IntegrationDef[]) : [];
    } catch {
      return [];
    }
  }
  function writeOwn(defs: IntegrationDef[]) {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(defs, null, 2));
    fs.renameSync(tmp, file);
  }

  /** Your own integrations; one you hand-edited into something invalid is listed with its problems and adds no blocks. */
  function own(): IntegrationInfo[] {
    return readOwn().map((d) => integrationInfo(d, LOCAL_INTEGRATIONS, true, integrationProblems(d)));
  }

  function list(): IntegrationInfo[] {
    return [...packs.load().integrations, ...own()];
  }

  function get(id: string): IntegrationInfo | undefined {
    return list().find((i) => i.id === id);
  }

  return {
    list,
    get,
    /** Blocks for your own integrations' actions (pack integrations' blocks come with the pack). */
    ownBlocks(): BlockDef[] {
      return own().filter((i) => !i.problems.length).flatMap(integrationBlocks);
    },

    /** Add or replace one of your own (`previousId` = the id it had, when it's renamed). */
    save(def: IntegrationDef, previousId?: string): IntegrationInfo {
      const bad = integrationProblems(def);
      if (bad.length) throw new Error(bad.join("; "));
      const defs = readOwn();
      if (defs.some((d) => d.id === def.id) && def.id !== previousId) throw new Error(`You already have an integration with id "${def.id}"`);
      writeOwn([...defs.filter((d) => d.id !== def.id && d.id !== previousId), def]);
      status.delete(`${LOCAL_INTEGRATIONS}/${def.id}`);
      if (previousId) status.delete(`${LOCAL_INTEGRATIONS}/${previousId}`);
      return integrationInfo(def, LOCAL_INTEGRATIONS, true);
    },

    remove(id: string) {
      const defs = readOwn();
      if (!defs.some((d) => d.id === id)) throw new Error(`No integration "${id}" of your own`);
      writeOwn(defs.filter((d) => d.id !== id));
      status.delete(`${LOCAL_INTEGRATIONS}/${id}`);
    },

    /** Is the harness installed? Cached for a minute; `force` checks again. */
    async status(id: string, force = false): Promise<IntegrationStatus> {
      const cached = status.get(id);
      if (cached && !force && Date.now() - cached.checkedAt < STATUS_TTL) return cached;
      const info = get(id);
      if (!info) throw new Error(`Integration "${id}" not found`);
      const blocked = blockedReason(info);
      let s: IntegrationStatus;
      if (blocked) s = { id, installed: false, error: blocked, checkedAt: Date.now() };
      else {
        const args = info.def.detect?.args ?? ["--version"];
        try {
          const r = await exec(info.def, args, { timeoutMs: CHECK_TIMEOUT_MS, env: process.env });
          const text = `${r.stdout}\n${r.stderr}`;
          s = r.code === 0
            ? { id, installed: true, version: parseVersion(text, info.def.detect?.pattern), path: r.path, checkedAt: Date.now() }
            : { id, installed: false, path: r.path, error: `${info.def.command} ${args.join(" ")} exited with code ${r.code}${r.stderr.trim() ? `: ${r.stderr.trim().slice(-300)}` : ""}`, checkedAt: Date.now() };
        } catch (e) {
          const err = e as NodeJS.ErrnoException;
          s = { id, installed: false, error: err.code === "ENOENT" ? `"${info.def.command}" isn't installed (or not on PATH)` : err.message, checkedAt: Date.now() };
        }
      }
      status.set(id, s);
      return s;
    },

    /** Load a select option's choices by running the harness (`choicesFrom`), with the env values you've set. */
    async choices(id: string, actionId: string, optionId: string, env: EnvValues): Promise<IntegrationChoice[]> {
      const info = get(id);
      if (!info) throw new Error(`Integration "${id}" not found`);
      const blocked = blockedReason(info);
      if (blocked) throw new Error(blocked);
      const action = info.def.actions.find((a) => a.id === actionId);
      if (!action) throw new Error(`Integration "${info.def.name}" has no action "${actionId}"`);
      const option = actionOptions(info.def, action).find((o) => o.id === optionId);
      if (!option?.choicesFrom) throw new Error(`Option "${optionId}" has no choices to load`);
      const names = [...new Set([...(info.def.env ?? []), ...(action.env ?? [])])];
      const vars: TemplateVars = {};
      for (const n of names) if (env[n] !== undefined) vars[`env.${n}`] = env[n];
      const args = option.choicesFrom.args.map((a) => renderTemplate(a, vars));
      const repo = env.REPO_PATH?.trim();
      const cwd = repo && fs.existsSync(repo) ? repo : undefined;
      let r;
      try {
        r = await exec(info.def, args, { cwd, timeoutMs: CHOICES_TIMEOUT_MS, env: { ...process.env, ...Object.fromEntries(names.filter((n) => env[n] !== undefined).map((n) => [n, env[n]])) } });
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        throw new Error(err.code === "ENOENT" ? `"${info.def.command}" isn't installed (or not on PATH)` : err.message);
      }
      if (r.code !== 0) throw new Error(`${info.def.command} ${args.join(" ")} exited with code ${r.code}${r.stderr.trim() ? `: ${r.stderr.trim().slice(-500)}` : ""}`);
      return parseChoices(r.stdout, option.choicesFrom.pattern);
    },
  };
}
