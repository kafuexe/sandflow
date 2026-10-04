import { useEffect, useMemo, useState } from "react";
import { Copy, ExternalLink, Lock, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { BlockIcon, ICONS } from "@/lib/icons";
import { useStore } from "@/lib/store";
import { ENDPOINT_ENV } from "../../shared/agents";
import { applyConfig, ENV_NAME_RE, resolveInherited, wouldCycle } from "../../shared/resolve";
import type { AgentProvider, AutoAction, BlockConfig, BlockDef, BlockKind, Effort, SkillRef } from "../../shared/types";
import { validateBlocks } from "../../shared/validate";
import { ConditionEditor } from "./ConditionEditor";
import { SkillsEditor } from "./SkillsEditor";
import { TriggerEditor } from "./TriggerEditor";

const PROVIDERS: AgentProvider[] = ["claudeCode", "codex", "pi", "opencode", "cursor", "copilot"];
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
const NONE = "__none__";

const newId = (template: boolean) => `${template ? "tpl" : "blk"}-${Math.random().toString(36).slice(2, 9)}`;

function newBlock(template: boolean, blocks: BlockDef[]): BlockDef {
  // New blocks start from the base pack's AI agent template when it's installed.
  const agentTpl = blocks.find((b) => b.id === "base/tpl-ai-agent") ?? blocks.find((b) => b.id === "tpl-ai-agent");
  return {
    id: newId(template),
    name: template ? "New template" : "New block",
    isTemplate: template,
    extends: template ? null : (agentTpl?.id ?? null),
    config: {},
  };
}

/** A labelled field with a ↺ button when the block overrides the inherited value. */
function Field({
  label,
  overridden,
  onReset,
  inheritable,
  children,
}: {
  label: string;
  overridden?: boolean;
  onReset?: () => void;
  inheritable?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Label className="text-xs">{label}</Label>
        {overridden && onReset && (
          <button type="button" onClick={onReset} className="text-muted-foreground hover:text-foreground" title="Reset to inherited">
            <RotateCcw className="size-3" />
          </button>
        )}
        {!overridden && inheritable && <span className="text-[10px] text-muted-foreground">inherited</span>}
      </div>
      {children}
    </div>
  );
}

export function BlockEditor() {
  const target = useStore((s) => s.editor);
  const data = useStore((s) => s.data);
  const { openEditor, upsertBlock, deleteBlock } = useStore.getState();
  const [draft, setDraft] = useState<BlockDef | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [envInput, setEnvInput] = useState("");

  useEffect(() => {
    setErrors([]);
    setEnvInput("");
    if (!target || !data) return setDraft(null);
    if ("create" in target) setDraft(newBlock(target.create === "template", data.blocks));
    else {
      const b = data.blocks.find((x) => x.id === target.id);
      setDraft(b ? structuredClone(b) : null);
    }
  }, [target, data?.blocks.length]);

  const blocks = useMemo(() => {
    if (!data || !draft) return [];
    return data.blocks.some((b) => b.id === draft.id)
      ? data.blocks.map((b) => (b.id === draft.id ? draft : b))
      : [...data.blocks, draft];
  }, [data, draft]);

  if (!draft || !data) return null;
  const isNew = !data.blocks.some((b) => b.id === draft.id);
  // Blocks from packs (and Sandflow's built-ins) are read-only; duplicate one to make your own.
  const readOnly = !!draft.pack;
  const packInfo = draft.pack ? data.packs?.find((p) => p.id === draft.pack) : undefined;
  const inherited = resolveInherited(draft, blocks);
  const cfg = applyConfig(inherited, draft.config);
  const c = draft.config;

  const set = (patch: Partial<BlockDef>) => setDraft({ ...draft, ...patch });
  const setCfg = (patch: BlockConfig) => {
    const config: BlockConfig = { ...c, ...patch };
    for (const k of Object.keys(config) as (keyof BlockConfig)[]) if (config[k] === undefined) delete config[k];
    setDraft({ ...draft, config });
  };
  const setIo = (which: "inputs" | "outputs", key: string, value: boolean | undefined) => {
    const next = { ...(c[which] as Record<string, boolean | undefined>), [key]: value };
    if (value === undefined) delete next[key];
    setCfg({ [which]: Object.keys(next).length ? next : undefined });
  };
  const setAgent = (key: "provider" | "model" | "effort" | "endpoint" | "endpointEnv", value: string | undefined) => {
    const next: Record<string, string | undefined> = { ...c.agent, [key]: value };
    if (value === undefined) delete next[key];
    setCfg({ agent: Object.keys(next).length ? (next as BlockConfig["agent"]) : undefined });
  };

  const templates = data.blocks.filter((b) => b.isTemplate && b.id !== draft.id && !wouldCycle(draft.id, b.id, blocks));
  const usedInFlows = data.flows.filter((f) => f.nodes.some((n) => n.data.blockId === draft.id)).map((f) => f.name);
  const extendedBy = data.blocks.filter((b) => b.extends === draft.id).map((b) => b.name);
  const deleteBlockedBy = [
    ...(draft.builtin ? ["built-in block"] : []),
    ...(draft.pack ? ["it comes from a pack"] : []),
    ...usedInFlows.map((n) => `flow "${n}"`),
    ...extendedBy.map((n) => `"${n}" extends it`),
  ];

  const ownSkills = c.skills ?? [];
  /** Trigger, If and the subflow plumbing have no agent, skills or configurable inputs/outputs. */
  const simple = cfg.kind === "trigger" || cfg.kind === "condition" || cfg.kind === "subflow" || cfg.kind === "flow-input" || cfg.kind === "flow-output";
  const setScript = (patch: Partial<NonNullable<BlockConfig["script"]>>) => {
    const next = { ...c.script, ...patch };
    for (const k of Object.keys(next) as (keyof typeof next)[]) if (next[k] === undefined) delete next[k];
    setCfg({ script: Object.keys(next).length ? next : undefined });
  };
  const duplicate = () => {
    // A copy you own: same settings, no pack. Templates are better extended, but a copy is what was asked for.
    const copy: BlockDef = { id: newId(draft.isTemplate), name: `${draft.name} (copy)`, isTemplate: draft.isTemplate, extends: draft.extends ?? null, config: structuredClone(draft.config) };
    upsertBlock(copy);
    openEditor({ id: copy.id });
  };

  const addEnv = () => {
    const name = envInput.trim().toUpperCase();
    if (!ENV_NAME_RE.test(name) || cfg.env.includes(name)) return;
    setCfg({ env: [...(c.env ?? []), name] });
    setEnvInput("");
  };

  const save = () => {
    const next = isNew ? [...data.blocks, draft] : data.blocks.map((b) => (b.id === draft.id ? draft : b));
    const errs = validateBlocks(next, new Set([draft.id]));
    if (!draft.name.trim()) errs.unshift("Name is required");
    setErrors(errs);
    if (errs.length) return;
    upsertBlock(draft);
    openEditor(null);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && openEditor(null)}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 p-0 sm:max-w-3xl">
        <DialogHeader className="border-b p-4">
          <DialogTitle className="flex items-center gap-2">
            <BlockIcon name={cfg.icon} className="size-5" />
            {isNew ? `New ${draft.isTemplate ? "template" : "block"}` : `Edit ${draft.name}`}
          </DialogTitle>
          <DialogDescription>
            {readOnly
              ? `From ${packInfo ? `the ${packInfo.name} pack (${packInfo.version})` : draft.pack === "sandflow" ? "Sandflow itself" : `the ${draft.pack} pack`} — view only. Duplicate it to make your own copy${draft.isTemplate ? ", or create a block that extends it" : ""}.`
              : `Unset fields inherit from ${draft.extends ? `"${data.blocks.find((b) => b.id === draft.extends)?.name}"` : "the defaults"}.`}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex min-h-0 flex-1 flex-col" viewportClassName="min-h-0 flex-1">
        <fieldset disabled={readOnly} className="min-w-0 space-y-5 p-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Name">
              <Input value={draft.name} onChange={(e) => set({ name: e.target.value })} aria-invalid={!draft.name.trim()} />
            </Field>
            <Field label="Extends">
              <Select value={draft.extends ?? NONE} onValueChange={(v) => set({ extends: v === NONE ? null : v })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>— nothing —</SelectItem>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={draft.isTemplate} onCheckedChange={(v) => set({ isTemplate: v })} />
              Is template <span className="text-xs text-muted-foreground">(can be extended by blocks and templates)</span>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={cfg.allowQuestions} onCheckedChange={(v) => setCfg({ allowQuestions: v })} />
              Allow questions
              {c.allowQuestions !== undefined && (
                <button type="button" onClick={() => setCfg({ allowQuestions: undefined })} title="Reset to inherited">
                  <RotateCcw className="size-3 text-muted-foreground" />
                </button>
              )}
            </label>
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto] gap-4">
            <Field label="Kind" overridden={c.kind !== undefined} onReset={() => setCfg({ kind: undefined })} inheritable>
              <Select value={cfg.kind} onValueChange={(v) => setCfg({ kind: v as BlockKind })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">auto — deterministic logic</SelectItem>
                  <SelectItem value="ai">ai — agent in sandbox</SelectItem>
                  <SelectItem value="manager">manager — AI router</SelectItem>
                  <SelectItem value="trigger">trigger — starts the flow on an event</SelectItem>
                  <SelectItem value="condition">if — deterministic true / false</SelectItem>
                  <SelectItem value="script">script — run code from a pack (container or this machine)</SelectItem>
                  {simple && (cfg.kind === "subflow" || cfg.kind === "flow-input" || cfg.kind === "flow-output") && (
                    <SelectItem value={cfg.kind}>{cfg.kind} (built in)</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Icon" overridden={c.icon !== undefined} onReset={() => setCfg({ icon: undefined })} inheritable>
              <Select value={cfg.icon} onValueChange={(v) => setCfg({ icon: v })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.keys(ICONS).map((k) => (
                    <SelectItem key={k} value={k}>
                      <BlockIcon name={k} /> {k}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Color" overridden={c.color !== undefined} onReset={() => setCfg({ color: undefined })} inheritable>
              <input
                type="color"
                value={cfg.color}
                onChange={(e) => setCfg({ color: e.target.value })}
                className="h-9 w-14 cursor-pointer rounded border bg-transparent"
              />
            </Field>
            <Field label="Max iterations" overridden={c.maxIterations !== undefined} onReset={() => setCfg({ maxIterations: undefined })} inheritable>
              <Input
                type="number"
                min={1}
                max={50}
                className="w-24"
                value={cfg.maxIterations}
                onChange={(e) => setCfg({ maxIterations: Math.max(1, Number(e.target.value) || 1) })}
              />
            </Field>
          </div>

          <Field label="Description" overridden={c.description !== undefined} onReset={() => setCfg({ description: undefined })} inheritable>
            <Input
              value={c.description ?? ""}
              placeholder={inherited.description}
              onChange={(e) => setCfg({ description: e.target.value })}
            />
          </Field>

          {!simple && <div className="grid grid-cols-2 gap-4">
            {(["inputs", "outputs"] as const).map((which) => (
              <div key={which} className="space-y-2 rounded-lg border p-3">
                <div className="text-xs font-medium capitalize">{which}</div>
                {(which === "inputs" ? (["artifact", "steer", "startingPrompt"] as const) : (["artifact", "steer"] as const)).map((k) => {
                  const own = (c[which] as Record<string, boolean | undefined> | undefined)?.[k];
                  return (
                    <label key={k} className="flex items-center gap-2 text-sm">
                      <Switch
                        checked={(cfg[which] as Record<string, boolean>)[k]}
                        onCheckedChange={(v) => setIo(which, k, v)}
                      />
                      {k === "startingPrompt" ? "starting prompt (global)" : k}
                      {own !== undefined ? (
                        <button type="button" onClick={() => setIo(which, k, undefined)} title="Reset to inherited">
                          <RotateCcw className="size-3 text-muted-foreground" />
                        </button>
                      ) : (
                        <span className="text-[10px] text-muted-foreground">inherited</span>
                      )}
                    </label>
                  );
                })}
              </div>
            ))}
          </div>}

          <Field label="Env var names (values are set globally in the Inputs panel)">
            <div className="flex flex-wrap items-center gap-1.5">
              {inherited.env.map((e) => (
                <Badge key={e} variant="secondary" className="font-mono" title="Inherited">
                  <Lock /> {e}
                </Badge>
              ))}
              {(c.env ?? [])
                .filter((e) => !inherited.env.includes(e))
                .map((e) => (
                  <Badge key={e} variant="outline" className="font-mono">
                    {e}
                    <button type="button" onClick={() => setCfg({ env: (c.env ?? []).filter((x) => x !== e) })}>
                      <X className="size-3" />
                    </button>
                  </Badge>
                ))}
              <form
                className="flex gap-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  addEnv();
                }}
              >
                <Input
                  value={envInput}
                  onChange={(e) => setEnvInput(e.target.value.toUpperCase())}
                  placeholder="ADD_VAR"
                  className="h-7 w-36 font-mono text-xs"
                  aria-invalid={envInput !== "" && !ENV_NAME_RE.test(envInput)}
                />
                <Button type="submit" size="sm" variant="outline" className="h-7" disabled={!ENV_NAME_RE.test(envInput)}>
                  <Plus />
                </Button>
              </form>
            </div>
          </Field>

          <Separator />

          {!simple && (
            <>
              <SkillsEditor inherited={inherited.skills} own={ownSkills} onChange={(skills) => setCfg({ skills })} />
              <Separator />
            </>
          )}

          {cfg.kind === "trigger" ? (
            <Field label="Trigger (defaults — each node can override them in its Block tab)" overridden={c.trigger !== undefined} onReset={() => setCfg({ trigger: undefined })} inheritable>
              <TriggerEditor value={cfg.trigger} onChange={(trigger) => setCfg({ trigger })} />
            </Field>
          ) : cfg.kind === "condition" ? (
            <Field label="Condition (default — each node can override it in its Block tab)" overridden={c.condition !== undefined} onReset={() => setCfg({ condition: undefined })} inheritable>
              <ConditionEditor value={cfg.condition} onChange={(condition) => setCfg({ condition })} />
            </Field>
          ) : cfg.kind === "script" ? (
            <div className="space-y-4">
              <Field label="Run (a shell command; $PACK_DIR = this pack's files, inputs as JSON on stdin)" overridden={c.script?.run !== undefined} onReset={() => setScript({ run: undefined })} inheritable>
                <Textarea
                  className="font-mono text-xs"
                  value={c.script?.run ?? ""}
                  placeholder={inherited.script.run || 'python "$PACK_DIR/scripts/check.py"'}
                  onChange={(e) => setScript({ run: e.target.value })}
                />
              </Field>
              <div className="grid grid-cols-3 gap-4">
                <Field label="Where" overridden={c.script?.where !== undefined} onReset={() => setScript({ where: undefined })} inheritable>
                  <Select value={cfg.script.where} onValueChange={(v) => setScript({ where: v as "sandbox" | "host" })}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="sandbox">In a container</SelectItem>
                      <SelectItem value="host">On this machine (trusted only)</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Exits (comma-separated)" overridden={c.script?.exits !== undefined} onReset={() => setScript({ exits: undefined })} inheritable>
                  <Input
                    className="font-mono text-xs"
                    defaultValue={cfg.script.exits.join(", ")}
                    key={cfg.script.exits.join(",")}
                    placeholder="pass, fail"
                    onBlur={(e) => setScript({ exits: [...new Set(e.target.value.split(",").map((x) => x.trim()).filter(Boolean))] })}
                  />
                </Field>
                <Field label="Timeout (seconds)" overridden={c.script?.timeoutSeconds !== undefined} onReset={() => setScript({ timeoutSeconds: undefined })} inheritable>
                  <Input
                    type="number"
                    min={1}
                    value={c.script?.timeoutSeconds ?? ""}
                    placeholder={String(inherited.script.timeoutSeconds ?? 1800)}
                    onChange={(e) => setScript({ timeoutSeconds: e.target.value ? Math.max(1, Number(e.target.value)) : undefined })}
                  />
                </Field>
              </div>
              <p className="text-[11px] text-muted-foreground">
                The script writes <code>{'{"artifact": …, "steer": …, "exit": "<name>"}'}</code> to <code>$SANDFLOW_OUTPUT</code>, or just prints the
                artifact. With exits, the flow continues out of the one it picks. It runs in the run&apos;s sandbox when the block needs{" "}
                <code>REPO_PATH</code>, otherwise in a throwaway container.
              </p>
            </div>
          ) : simple ? null : cfg.kind === "auto" ? (
            <div className="space-y-4">
              <Field label="Action" overridden={c.autoAction !== undefined} onReset={() => setCfg({ autoAction: undefined })} inheritable>
                <Select value={cfg.autoAction} onValueChange={(v) => setCfg({ autoAction: v as AutoAction })}>
                  <SelectTrigger className="w-64">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="create-task">create-task — create branch</SelectItem>
                    <SelectItem value="create-mr">create-mr — push + open MR</SelectItem>
                    <SelectItem value="shell">shell — run a command</SelectItem>
                    <SelectItem value="post-comment">post-comment — reply on the triggering issue / MR</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              {cfg.autoAction === "shell" && (
                <Field label="Shell command (runs on the host in REPO_PATH; $SANDFLOW_ARTIFACT / $SANDFLOW_STEER available)" overridden={c.shellCommand !== undefined} onReset={() => setCfg({ shellCommand: undefined })} inheritable>
                  <Textarea
                    className="font-mono text-xs"
                    value={c.shellCommand ?? ""}
                    placeholder={inherited.shellCommand}
                    onChange={(e) => setCfg({ shellCommand: e.target.value })}
                  />
                </Field>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-4">
                <Field label="Agent" overridden={c.agent?.provider !== undefined} onReset={() => setAgent("provider", undefined)} inheritable>
                  <Select value={cfg.agent.provider} onValueChange={(v) => setAgent("provider", v)}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PROVIDERS.map((p) => (
                        <SelectItem key={p} value={p}>
                          {p}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Model" overridden={c.agent?.model !== undefined} onReset={() => setAgent("model", undefined)} inheritable>
                  <Input
                    value={c.agent?.model ?? ""}
                    placeholder={inherited.agent.model}
                    onChange={(e) => setAgent("model", e.target.value || undefined)}
                  />
                </Field>
                <Field label="Effort" overridden={c.agent?.effort !== undefined} onReset={() => setAgent("effort", undefined)} inheritable>
                  <Select value={cfg.agent.effort ?? "high"} onValueChange={(v) => setAgent("effort", v)}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {EFFORTS.map((e) => (
                        <SelectItem key={e} value={e}>
                          {e}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <div className="grid grid-cols-[2fr_1fr] gap-4">
                <Field label="Endpoint (on-prem / proxy — empty = provider default)" overridden={c.agent?.endpoint !== undefined} onReset={() => setAgent("endpoint", undefined)} inheritable>
                  <Input
                    value={c.agent?.endpoint ?? ""}
                    placeholder={inherited.agent.endpoint || "https://llm.internal.corp/anthropic"}
                    onChange={(e) => setAgent("endpoint", e.target.value || undefined)}
                    aria-invalid={!!cfg.agent.endpoint && !/^https?:\/\/\S+$/i.test(cfg.agent.endpoint)}
                    className="font-mono text-xs"
                  />
                </Field>
                <Field label="Endpoint env var" overridden={c.agent?.endpointEnv !== undefined} onReset={() => setAgent("endpointEnv", undefined)} inheritable>
                  <Input
                    value={c.agent?.endpointEnv ?? ""}
                    placeholder={inherited.agent.endpointEnv || ENDPOINT_ENV[cfg.agent.provider] || "required for this agent"}
                    onChange={(e) => setAgent("endpointEnv", e.target.value.toUpperCase() || undefined)}
                    aria-invalid={
                      (!!cfg.agent.endpoint && !cfg.agent.endpointEnv && !ENDPOINT_ENV[cfg.agent.provider]) ||
                      (!!c.agent?.endpointEnv && !ENV_NAME_RE.test(c.agent.endpointEnv))
                    }
                    className="font-mono text-xs"
                  />
                </Field>
              </div>
              {cfg.agent.endpoint && (
                <p className="-mt-2 text-[11px] text-muted-foreground">
                  Inside a Docker/Podman sandbox, <code>localhost</code> is the container — use <code>host.docker.internal</code> for a
                  service on this machine. For auth, add e.g. <code>ANTHROPIC_AUTH_TOKEN</code> to the block's env vars above.
                </p>
              )}
              <Field label="Instructions" overridden={c.instructions !== undefined} onReset={() => setCfg({ instructions: undefined })} inheritable>
                <Textarea
                  rows={6}
                  className="max-h-72 text-xs"
                  value={c.instructions ?? ""}
                  placeholder={inherited.instructions || "Role instructions for the agent"}
                  onChange={(e) => setCfg({ instructions: e.target.value })}
                />
              </Field>
              <Field label="Extra instructions (appended to inherited ones)" overridden={c.extraInstructions !== undefined} onReset={() => setCfg({ extraInstructions: undefined })}>
                <Textarea
                  rows={3}
                  className="max-h-48 text-xs"
                  value={c.extraInstructions ?? ""}
                  placeholder={inherited.extraInstructions}
                  onChange={(e) => setCfg({ extraInstructions: e.target.value || undefined })}
                />
              </Field>
            </div>
          )}

          {errors.length > 0 && (
            <div className="space-y-1 rounded border border-red-500/60 bg-red-500/10 p-2 text-xs text-red-300">
              {errors.map((e) => (
                <div key={e}>{e}</div>
              ))}
            </div>
          )}
        </fieldset>
        </ScrollArea>

        <DialogFooter className="items-center border-t p-4">
          {readOnly && (
            <Button variant="outline" size="sm" className="mr-auto" onClick={duplicate}>
              <Copy /> Duplicate as my own
            </Button>
          )}
          {!isNew && !readOnly && (
            <div className="mr-auto flex items-center gap-2">
              <Button
                variant="destructive"
                size="sm"
                disabled={deleteBlockedBy.length > 0}
                onClick={() => {
                  deleteBlock(draft.id);
                  openEditor(null);
                }}
              >
                <Trash2 /> Delete
              </Button>
              {deleteBlockedBy.length > 0 && (
                <span className="text-[11px] text-muted-foreground">Can't delete: {deleteBlockedBy.join(", ")}</span>
              )}
            </div>
          )}
          <Button variant="outline" onClick={() => openEditor(null)}>
            {readOnly ? "Close" : "Cancel"}
          </Button>
          {!readOnly && <Button onClick={save}>Save</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
