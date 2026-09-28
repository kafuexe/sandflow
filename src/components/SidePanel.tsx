import { Copy, ExternalLink, Pencil, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useCurrentFlow, useStore, type SideTab } from "@/lib/store";
import { resolveNode } from "../../shared/resolve";
import { skillKey } from "../../shared/skills";
import type { BlockDef, ResolvedConfig } from "../../shared/types";
import { InputsPanel } from "./InputsPanel";
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
                  <span className="truncate text-muted-foreground">({s.file ? (s.file.store === "bundled" ? "bundled file" : "uploaded file") : s.source})</span>
                </div>
              ))
            : "—"}
        </div>
      </Row>
      {cfg.kind !== "auto" && (
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

function BlockPanel() {
  const flow = useCurrentFlow();
  const blocks = useStore((s) => s.data?.blocks ?? []);
  const selectedId = useStore((s) => s.selectedNodeId);
  const { updateNodeData, updateNodeOverrides, removeNode, openEditor, upsertBlock } = useStore.getState();
  const node = flow?.nodes.find((n) => n.id === selectedId);

  if (!node) return <div className="p-4 text-sm text-muted-foreground">Select a block on the canvas.</div>;
  const block = blocks.find((b) => b.id === node.data.blockId);
  let cfg: ResolvedConfig | undefined;
  let error: string | undefined;
  try {
    cfg = resolveNode(node, blocks);
  } catch (e) {
    error = (e as Error).message;
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
          </div>
        </div>
        {error && <div className="text-xs text-red-400">{error}</div>}
        {cfg && cfg.kind !== "auto" && (
          <label className="flex items-center justify-between text-sm">
            Allow questions
            <Switch checked={cfg.allowQuestions} onCheckedChange={(v) => updateNodeOverrides(node.id, { allowQuestions: v })} />
          </label>
        )}
        {cfg && cfg.kind !== "auto" && (
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
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => block && openEditor({ id: block.id })} disabled={!block}>
            <Pencil /> Edit block definition
          </Button>
          <Button size="sm" variant="outline" onClick={duplicate} disabled={!block}>
            <Copy /> Duplicate as new block
          </Button>
          <Button size="sm" variant="destructive" onClick={() => removeNode(node.id)}>
            <Trash2 /> Delete node
          </Button>
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
