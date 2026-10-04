import { Copy, ExternalLink, Lock, Pencil, Radio, ShieldAlert, ShieldCheck, Trash2, Workflow } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useCurrentFlow, useStore, type SideTab } from "@/lib/store";
import { cn } from "@/lib/utils";
import { CORE_PACK } from "../../shared/packs";
import { templateChain } from "../../shared/resolve";
import { skillKey } from "../../shared/skills";
import { EXIT_NAME_RE, flowInterface, resolveNodeIn, subflowCycle } from "../../shared/subflow";
import type { BlockDef, Flow, FlowNode, ResolvedConfig } from "../../shared/types";
import { ConditionEditor } from "./ConditionEditor";
import { InputsPanel } from "./InputsPanel";
import { TriggerEditor } from "./TriggerEditor";
import { RunPanel } from "./RunPanel";

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[88px_1fr] gap-2 text-xs">
      <div className="text-muted-foreground">{k}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

const onOff = (o: Record<string, boolean>) =>
  Object.entries(o)
    .filter(([, v]) => v)
    .map(([k]) => (k === "startingPrompt" ? "starting prompt" : k))
    .join(", ") || "—";

function Summary({ cfg }: { cfg: ResolvedConfig }) {
  return (
    <div className="space-y-2 rounded-lg border p-2">
      <Row k="Kind">{cfg.kind}{cfg.kind === "auto" && ` · ${cfg.autoAction}`}</Row>
      <Row k="Inputs">{onOff(cfg.inputs)}</Row>
      <Row k="Outputs">{onOff(cfg.outputs)}</Row>
      <Row k="Env">
        <div className="flex flex-wrap gap-1">
          {cfg.env.length ? cfg.env.map((e) => <Badge key={e} variant="outline" className="font-mono text-[10px]">{e}</Badge>) : "—"}
        </div>
      </Row>
      <Row k="Skills">
        <div className="space-y-0.5">
          {cfg.skills.length
            ? cfg.skills.map((s) => (
                <div key={skillKey(s)} className="flex items-center gap-1">
                  {s.url ? (
                    <a href={s.url} target="_blank" rel="noreferrer" className="flex items-center gap-1 hover:underline">
                      {s.name} <ExternalLink className="size-3" />
                    </a>
                  ) : (
                    s.name
                  )}
                  <span className="truncate text-muted-foreground">
                    ({s.file ? (s.file.store === "bundled" ? "bundled file" : s.file.store === "pack" ? `pack ${s.file.pack}` : "uploaded file") : s.source})
                  </span>
                </div>
              ))
            : "—"}
        </div>
      </Row>
      {(cfg.kind === "ai" || cfg.kind === "manager") && (
        <>
          <Row k="Agent">
            {cfg.agent.provider} · {cfg.agent.model} · {cfg.agent.effort}
            {cfg.maxIterations > 1 && ` · ≤${cfg.maxIterations} iterations`}
            {cfg.agent.endpoint && <div className="truncate font-mono text-muted-foreground" title={cfg.agent.endpoint}>→ {cfg.agent.endpoint}</div>}
          </Row>
          <Row k="Instructions">
            <div className="line-clamp-6 whitespace-pre-wrap text-muted-foreground">
              {[cfg.instructions, cfg.extraInstructions].filter(Boolean).join("\n\n") || "—"}
            </div>
          </Row>
        </>
      )}
      {cfg.kind === "auto" && cfg.autoAction === "shell" && (
        <Row k="Command">
          <code className="break-all">{cfg.shellCommand || "—"}</code>
        </Row>
      )}
    </div>
  );
}

/** Which flow a subflow node runs, and what that flow takes in / gives back. */
function SubflowEditor({ flow, node, cfg, readOnly }: { flow: Flow; node: FlowNode; cfg: ResolvedConfig & { exits: string[] }; readOnly: boolean }) {
  const flows = useStore((s) => s.data?.flows ?? []);
  const blocks = useStore((s) => s.data?.blocks ?? []);
  const { updateNodeOverrides, updateNodeData, setCurrentFlow } = useStore.getState();
  const child = flows.find((f) => f.id === cfg.subflow.flowId);
  // Only flows that wouldn't make this flow contain itself.
  const choices = flows.filter((f) => {
    if (f.id === flow.id) return false;
    const trial = flows.map((x) =>
      x.id === flow.id ? { ...x, nodes: x.nodes.map((n) => (n.id === node.id ? { ...n, data: { ...n.data, overrides: { ...n.data.overrides, subflow: { flowId: f.id } } } } : n)) } : x,
    );
    return !subflowCycle(flow.id, trial, blocks);
  });
  const fi = child ? flowInterface(child, blocks) : undefined;
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium">Flow to run</div>
      <Select
        disabled={readOnly}
        value={cfg.subflow.flowId || undefined}
        onValueChange={(id) => {
          updateNodeOverrides(node.id, { subflow: { flowId: id } });
          const picked = flows.find((f) => f.id === id);
          if (picked && (!node.data.label || node.data.label === child?.name)) updateNodeData(node.id, { label: picked.name });
        }}
      >
        <SelectTrigger size="sm" className="w-full">
          <SelectValue placeholder="Pick a flow" />
        </SelectTrigger>
        <SelectContent>
          {choices.map((f) => (
            <SelectItem key={f.id} value={f.id}>
              {f.name}
              {f.pack && <span className="text-muted-foreground"> · {f.pack}</span>}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {child && fi && (
        <div className="space-y-1.5 rounded-lg border p-2 text-xs">
          <Row k="Takes">
            {fi.hasInput ? [fi.inputs.artifact && "artifact", fi.inputs.steer && "steer"].filter(Boolean).join(", ") || "nothing" : <span className="text-amber-400">no Flow input (it gets nothing from here)</span>}
          </Row>
          <Row k="Exits">
            {fi.exits.length ? fi.exits.join(", ") : <span className="text-amber-400">no Flow output (nothing continues after it)</span>}
          </Row>
          <p className="text-[11px] text-muted-foreground">
            Set on that flow&apos;s <b>Flow input</b> and <b>Flow output</b> blocks.
          </p>
          <Button size="sm" variant="outline" onClick={() => setCurrentFlow(child.id)}>
            <Workflow /> Open “{child.name}”
          </Button>
        </div>
      )}
    </div>
  );
}

/** A Script node: what it runs, where, and its named exits. */
function ScriptEditor({ node, cfg, pack }: { node: FlowNode; cfg: ResolvedConfig; pack?: string }) {
  const packs = useStore((s) => s.data?.packs ?? []);
  const { updateNodeOverrides } = useStore.getState();
  const own = node.data.overrides?.script ?? {};
  const set = (patch: Partial<NonNullable<typeof own>>) => {
    const next = { ...own, ...patch };
    for (const k of Object.keys(next) as (keyof typeof next)[]) if (next[k] === undefined) delete next[k];
    updateNodeOverrides(node.id, { script: Object.keys(next).length ? next : undefined });
  };
  const info = pack ? packs.find((p) => p.id === pack) : undefined;
  const exitsText = cfg.script.exits.join(", ");
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="script-run">Run (this node)</Label>
        <Textarea
          id="script-run"
          rows={2}
          className="font-mono text-xs"
          value={own.run ?? ""}
          placeholder={cfg.script.run || 'python "$PACK_DIR/scripts/report.py"'}
          onChange={(e) => set({ run: e.target.value || undefined })}
        />
        <p className="text-[11px] text-muted-foreground">
          Gets its inputs as JSON on stdin, writes <code>{"{artifact, steer, exit}"}</code> to <code>$SANDFLOW_OUTPUT</code> (or prints the artifact).
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1.5">
          <Label>Where</Label>
          <Select value={cfg.script.where} onValueChange={(v) => set({ where: v as "sandbox" | "host" })}>
            <SelectTrigger size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="sandbox">In a container</SelectItem>
              <SelectItem value="host">On this machine</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="script-timeout">Timeout (s)</Label>
          <Input
            id="script-timeout"
            type="number"
            min={1}
            className="h-8"
            value={own.timeoutSeconds ?? ""}
            placeholder={String(cfg.script.timeoutSeconds ?? 1800)}
            onChange={(e) => set({ timeoutSeconds: e.target.value ? Math.max(1, Number(e.target.value)) : undefined })}
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="script-exits">Exits (comma-separated; empty = plain artifact/steer outputs)</Label>
        <Input
          id="script-exits"
          className="h-8 font-mono text-xs"
          defaultValue={exitsText}
          key={exitsText}
          placeholder="pass, fail"
          onBlur={(e) => {
            const exits = [...new Set(e.target.value.split(",").map((x) => x.trim()).filter((x) => EXIT_NAME_RE.test(x)))];
            if (exits.join(", ") !== exitsText) set({ exits });
          }}
        />
      </div>
      {pack && (
        <div className="flex items-start gap-1.5 rounded-lg border p-2 text-[11px] text-muted-foreground">
          {info?.trustHost ? <ShieldCheck className="size-3.5 shrink-0 text-emerald-400" /> : <ShieldAlert className="size-3.5 shrink-0 text-amber-400" />}
          <span>
            Uses files from the <b>{info?.name ?? pack}</b> pack ($PACK_DIR).{" "}
            {info?.trustHost
              ? "That pack may run code on this machine."
              : "That pack's code only runs in a container — allow it in Packs to run it on this machine."}
          </span>
        </div>
      )}
    </div>
  );
}

/** Live status of a trigger node: webhook URL, next scheduled run, last poll / error. */
function TriggerStatusCard({ flowId, nodeId, cfg, active }: { flowId: string; nodeId: string; cfg: ResolvedConfig; active: boolean }) {
  const info = useStore((s) => s.triggers);
  const row = info?.triggers.find((t) => t.flowId === flowId && t.nodeId === nodeId);
  const t = cfg.trigger;
  if (t.type === "manual") return <div className="text-xs text-muted-foreground">Starts when you press Run.</div>;
  const mode = t.mode ?? "webhook";
  const hookUrl =
    t.type !== "schedule" && mode === "webhook" ? `${info?.webhooks.baseUrl ?? "<webhook listener>"}/hooks/${t.type}/${flowId}/${nodeId}` : undefined;
  return (
    <div className="space-y-1.5 rounded-lg border p-2 text-xs">
      <div className="flex items-center gap-1.5">
        <Radio className={cn("size-3.5", active ? "text-emerald-400" : "text-muted-foreground")} />
        {active ? (row ? "Listening" : "Starting…") : "Inactive — turn on Active in the top bar"}
      </div>
      {hookUrl && (
        <div className="space-y-1">
          <div className="text-muted-foreground">
            Webhook URL {t.type === "github" ? "(content type: application/json)" : ""}
          </div>
          <div className="flex items-center gap-1">
            <code className="min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-1" title={hookUrl}>
              {hookUrl}
            </code>
            <Button size="icon" variant="ghost" className="size-6" title="Copy" onClick={() => void navigator.clipboard?.writeText(hookUrl)}>
              <Copy className="size-3" />
            </Button>
          </div>
          {!info?.webhooks.enabled && <div className="text-amber-400">Enable the webhook listener in Settings → Webhooks.</div>}
          {info?.webhooks.error && <div className="text-red-400">{info.webhooks.error}</div>}
          <div className="text-muted-foreground">
            Secret: set <code>{t.secretEnv || "(choose an env var)"}</code> in Inputs and use the same value in {t.type === "github" ? "GitHub" : "GitLab"}.
          </div>
        </div>
      )}
      {row?.nextRun && <div>Next run: {new Date(row.nextRun).toLocaleString()}</div>}
      {row?.lastPoll && <div className="text-muted-foreground">Last poll: {new Date(row.lastPoll).toLocaleTimeString()}</div>}
      {row?.lastFired && <div className="text-muted-foreground">Last fired: {new Date(row.lastFired).toLocaleString()}</div>}
      {row?.lastError && <div className="text-red-400">{row.lastError}</div>}
    </div>
  );
}

function BlockPanel() {
  const flow = useCurrentFlow();
  const blocks = useStore((s) => s.data?.blocks ?? []);
  const flows = useStore((s) => s.data?.flows ?? []);
  const selectedId = useStore((s) => s.selectedNodeId);
  const { updateNodeData, updateNodeOverrides, removeNode, openEditor, upsertBlock, createFlow } = useStore.getState();
  const node = flow?.nodes.find((n) => n.id === selectedId);

  if (!node || !flow) return <div className="p-4 text-sm text-muted-foreground">Select a block on the canvas.</div>;
  const block = blocks.find((b) => b.id === node.data.blockId);
  let cfg: (ResolvedConfig & { exits: string[] }) | undefined;
  let error: string | undefined;
  try {
    cfg = resolveNodeIn(node, blocks, flows);
  } catch (e) {
    error = (e as Error).message;
  }
  const readOnly = !!flow.pack;
  let filesPack: string | undefined;
  try {
    filesPack = [...templateChain(node.data.blockId, blocks)].reverse().find((b) => b.pack && b.pack !== CORE_PACK)?.pack;
  } catch {
    /* broken chain */
  }

  const duplicate = () => {
    if (!block) return;
    const copy: BlockDef = {
      id: `blk-${Math.random().toString(36).slice(2, 9)}`,
      name: `${node.data.label || block.name} (copy)`,
      isTemplate: false,
      extends: block.extends ?? null,
      config: mergeOverrides(block.config, node.data.overrides),
    };
    upsertBlock(copy);
    updateNodeData(node.id, { blockId: copy.id, overrides: undefined });
    openEditor({ id: copy.id });
  };

  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 p-3">
        {readOnly && (
          <div className="flex items-center gap-2 rounded-lg border p-2 text-xs text-muted-foreground">
            <Lock className="size-3.5 shrink-0" />
            <span className="flex-1">This flow comes from the {flow.pack} pack and is view only.</span>
            <Button size="sm" variant="outline" className="h-7" onClick={() => createFlow(`${flow.name} (copy)`, flow.id)}>
              Duplicate
            </Button>
          </div>
        )}
        {/* Opening the flow a subflow runs works even when this flow is view only. */}
        {cfg?.kind === "subflow" && <SubflowEditor flow={flow} node={node} cfg={cfg} readOnly={readOnly} />}
        <fieldset disabled={readOnly} className="min-w-0 space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="node-label">Label</Label>
          <Input
            id="node-label"
            value={node.data.label ?? ""}
            placeholder={block?.name}
            onChange={(e) => updateNodeData(node.id, { label: e.target.value || undefined })}
            className="h-8"
          />
          <div className="text-[11px] text-muted-foreground">
            Block: {block?.name ?? node.data.blockId}
            {block?.isTemplate && " (template)"}
            {block?.pack && block.pack !== CORE_PACK && ` · ${block.pack} pack`}
          </div>
        </div>
        {cfg?.kind === "script" && <ScriptEditor node={node} cfg={cfg} pack={filesPack} />}
        {cfg?.kind === "flow-input" && (
          <div className="space-y-2">
            <div className="text-xs font-medium">What this flow takes in when it runs as a subflow</div>
            {(["artifact", "steer"] as const).map((k) => (
              <label key={k} className="flex items-center justify-between text-sm">
                {k}
                <Switch checked={cfg!.outputs[k]} onCheckedChange={(v) => updateNodeOverrides(node.id, { outputs: { ...node.data.overrides?.outputs, [k]: v } })} />
              </label>
            ))}
          </div>
        )}
        {cfg?.kind === "flow-output" && (
          <div className="space-y-1.5">
            <Label htmlFor="flow-output-name">Exit name</Label>
            <Input
              id="flow-output-name"
              className="h-8 font-mono"
              defaultValue={cfg.flowOutput.name}
              key={cfg.flowOutput.name}
              onBlur={(e) => {
                const name = e.target.value.trim();
                if (EXIT_NAME_RE.test(name) && name !== cfg!.flowOutput.name) updateNodeOverrides(node.id, { flowOutput: { name } });
                else e.target.value = cfg!.flowOutput.name;
              }}
            />
            <p className="text-[11px] text-muted-foreground">
              Where a parent flow continues when this flow reaches this block. Several outputs with different names = several exits (e.g. approved / rejected).
            </p>
          </div>
        )}
        {error && <div className="text-xs text-red-400">{error}</div>}
        {cfg?.kind === "trigger" && (
          <div className="space-y-3">
            <TriggerStatusCard flowId={flow!.id} nodeId={node.id} cfg={cfg} active={!!flow!.active} />
            <div className="text-xs font-medium">Trigger (this node)</div>
            <TriggerEditor value={cfg.trigger} allowTypeChange={false} onChange={(trigger) => updateNodeOverrides(node.id, { trigger })} />
          </div>
        )}
        {cfg?.kind === "condition" && (
          <div className="space-y-2">
            <div className="text-xs font-medium">Condition (this node)</div>
            <ConditionEditor value={cfg.condition} onChange={(condition) => updateNodeOverrides(node.id, { condition })} />
          </div>
        )}
        {cfg && (cfg.kind === "ai" || cfg.kind === "manager") && (
          <label className="flex items-center justify-between text-sm">
            Allow questions
            <Switch checked={cfg.allowQuestions} onCheckedChange={(v) => updateNodeOverrides(node.id, { allowQuestions: v })} />
          </label>
        )}
        {cfg && (cfg.kind === "ai" || cfg.kind === "manager") && (
          <div className="space-y-1.5">
            <Label htmlFor="node-extra">Extra instructions (this node only)</Label>
            <Textarea
              id="node-extra"
              rows={3}
              value={node.data.overrides?.extraInstructions ?? ""}
              onChange={(e) => updateNodeOverrides(node.id, { extraInstructions: e.target.value || undefined })}
              placeholder="Appended to the block's instructions"
            />
          </div>
        )}
        {cfg && <Summary cfg={cfg} />}
        </fieldset>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => block && openEditor({ id: block.id })} disabled={!block}>
            <Pencil /> {block?.pack ? "View block definition" : "Edit block definition"}
          </Button>
          {!readOnly && (
            <>
              <Button size="sm" variant="outline" onClick={duplicate} disabled={!block || block.pack === CORE_PACK}>
                <Copy /> Duplicate as new block
              </Button>
              <Button size="sm" variant="destructive" onClick={() => removeNode(node.id)}>
                <Trash2 /> Delete node
              </Button>
            </>
          )}
        </div>
      </div>
    </ScrollArea>
  );
}

/** Bake node overrides into a block config (used by "Duplicate as new block"). */
function mergeOverrides(config: BlockDef["config"], overrides: BlockDef["config"] | undefined): BlockDef["config"] {
  if (!overrides) return structuredClone(config);
  const merged = { ...structuredClone(config), ...structuredClone(overrides) };
  if (config.extraInstructions && overrides.extraInstructions) {
    merged.extraInstructions = `${config.extraInstructions}\n\n${overrides.extraInstructions}`;
  }
  return merged;
}

export function SidePanel() {
  const tab = useStore((s) => s.sideTab);
  const setTab = useStore((s) => s.setSideTab);
  const waiting = useStore((s) => !!s.run?.pendingQuestion);
  return (
    <aside className="flex h-full w-[360px] shrink-0 flex-col border-l bg-card/40">
      <Tabs value={tab} onValueChange={(v) => setTab(v as SideTab)} className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="p-2">
          <TabsList className="w-full">
            <TabsTrigger value="inputs">Inputs</TabsTrigger>
            <TabsTrigger value="block">Block</TabsTrigger>
            <TabsTrigger value="run">
              Run {waiting && <span className="size-2 animate-pulse rounded-full bg-amber-400" />}
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="inputs" className="min-h-0">
          <InputsPanel />
        </TabsContent>
        <TabsContent value="block" className="min-h-0">
          <BlockPanel />
        </TabsContent>
        <TabsContent value="run" className="min-h-0">
          <RunPanel />
        </TabsContent>
      </Tabs>
    </aside>
  );
}
