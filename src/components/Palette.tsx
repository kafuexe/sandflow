import { useMemo, useRef, useState } from "react";
import { ChevronRight, Copy, Package, Plus, Search, Trash2, Workflow, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BlockIcon } from "@/lib/icons";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { CORE_PACK } from "../../shared/packs";
import { nodeLabel, resolveBlock } from "../../shared/resolve";
import { flowInterface } from "../../shared/subflow";
import type { BlockDef, Flow, PackInfo, ResolvedConfig } from "../../shared/types";
import { DRAG_FLOW_MIME, DRAG_MIME } from "./FlowCanvas";

type PaletteTab = "blocks" | "templates" | "flows";

function PaletteItem({ block, blocks }: { block: BlockDef; blocks: BlockDef[] }) {
  const openEditor = useStore((s) => s.openEditor);
  let color = "#64748b";
  let icon = "box";
  let kind = "?";
  try {
    const cfg = resolveBlock(block.id, blocks);
    ({ color, icon, kind } = cfg);
  } catch {
    /* cycle — shown as-is */
  }
  const parent = block.extends ? blocks.find((b) => b.id === block.extends) : undefined;
  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_MIME, block.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={() => openEditor({ id: block.id })}
      title={`Drag onto the canvas · click to ${block.pack ? "view" : "edit"}`}
      className="flex w-full cursor-grab items-center gap-2 rounded-md border bg-card px-2 py-1.5 text-left hover:bg-accent active:cursor-grabbing"
    >
      <span className="size-2 shrink-0 rounded-full" style={{ background: color }} />
      <BlockIcon name={icon} className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{block.name}</span>
        {parent && <span className="block truncate text-[10px] text-muted-foreground">extends {parent.name}</span>}
      </span>
      <Badge variant="secondary" className="px-1 py-0 text-[9px] uppercase">
        {kind}
      </Badge>
      {block.isTemplate && (
        <Badge variant="outline" className="px-1 py-0 text-[9px]">
          tpl
        </Badge>
      )}
    </button>
  );
}

function FlowItem({ flow, blocks, current }: { flow: Flow; blocks: BlockDef[]; current: boolean }) {
  const { setCurrentFlow, createFlow, deleteFlow } = useStore.getState();
  const fi = useMemo(() => flowInterface(flow, blocks), [flow, blocks]);
  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_FLOW_MIME, flow.id);
        e.dataTransfer.effectAllowed = "copy";
      }}
      onClick={() => setCurrentFlow(flow.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setCurrentFlow(flow.id);
        }
      }}
      title="Click to open · drag onto the canvas to run it inside the open flow (a subflow)"
      className={cn(
        "group flex w-full cursor-grab items-start gap-2 rounded-md border bg-card px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 active:cursor-grabbing",
        current && "border-primary/60 bg-accent/60",
      )}
    >
      <Workflow className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{flow.name}</span>
        {flow.description && <span className="line-clamp-2 text-[10px] text-muted-foreground">{flow.description}</span>}
        <span className="mt-0.5 flex flex-wrap gap-1 text-[10px] text-muted-foreground">
          <span>{flow.nodes.length} blocks</span>
          {fi.hasInput && <span className="rounded bg-muted px-1" title="Has a Flow input: takes artifact/steer when used as a subflow">in</span>}
          {fi.exits.map((x) => (
            <span key={x} className="rounded bg-violet-500/15 px-1 text-violet-300" title="Flow output: an exit when used as a subflow">
              → {x}
            </span>
          ))}
          {flow.active && <span className="text-emerald-400">● active</span>}
        </span>
      </span>
      <span className="flex shrink-0 gap-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
        <button
          type="button"
          title={flow.pack ? "Duplicate into your flows (to edit it)" : "Duplicate"}
          aria-label={`Duplicate ${flow.name}`}
          className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation();
            createFlow(`${flow.name} (copy)`, flow.id);
          }}
        >
          <Copy className="size-3.5" />
        </button>
        {!flow.pack && (
          <button
            type="button"
            title="Delete flow"
            aria-label={`Delete ${flow.name}`}
            className="rounded p-1 text-muted-foreground hover:bg-background hover:text-red-400"
            onClick={(e) => {
              e.stopPropagation();
              if (confirm(`Delete flow "${flow.name}"?`)) deleteFlow(flow.id);
            }}
          >
            <Trash2 className="size-3.5" />
          </button>
        )}
      </span>
    </div>
  );
}

/** Everything a search can hit for one block: name, kind, description, action, the template it extends, id, pack. */
function blockSearchText(block: BlockDef, blocks: BlockDef[]): string {
  let cfg: ResolvedConfig | undefined;
  try {
    cfg = resolveBlock(block.id, blocks);
  } catch {
    /* cycle — search the raw fields */
  }
  const parent = block.extends ? blocks.find((b) => b.id === block.extends)?.name : "";
  return [block.name, block.id, block.pack, cfg?.kind, cfg?.description, cfg?.kind === "auto" ? cfg.autoAction : "", parent]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** A flow is found by its name, id, description, pack and the blocks it uses. */
function flowSearchText(flow: Flow, blocks: BlockDef[]): string {
  return [flow.name, flow.id, flow.description, flow.pack, ...flow.nodes.map((n) => nodeLabel(n, blocks))].filter(Boolean).join(" ").toLowerCase();
}

/** Group for an item's source: your own, Sandflow's built-ins, or a pack. */
function groupOf(pack: string | undefined, packs: PackInfo[]): { key: string; label: string; order: number } {
  if (!pack) return { key: "", label: "Mine", order: 0 };
  if (pack === CORE_PACK) return { key: pack, label: "Sandflow (built in)", order: 1 };
  const info = packs.find((p) => p.id === pack);
  return { key: pack, label: info ? `${info.name} · ${info.version}` : pack, order: 2 };
}

function grouped<T extends { pack?: string }>(items: T[], packs: PackInfo[]) {
  const groups = new Map<string, { label: string; order: number; items: T[] }>();
  for (const it of items) {
    const g = groupOf(it.pack, packs);
    const cur = groups.get(g.key) ?? { label: g.label, order: g.order, items: [] };
    cur.items.push(it);
    groups.set(g.key, cur);
  }
  return [...groups.entries()].sort(([a, x], [b, y]) => x.order - y.order || a.localeCompare(b)).map(([key, g]) => ({ key, ...g }));
}

function GroupHeader({ label, count, open, onToggle }: { label: string; count: number; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      title={open ? "Collapse" : "Expand"}
      className="flex w-full items-center gap-1.5 rounded px-1 pt-2 pb-0.5 text-left text-[10px] font-medium tracking-wide text-muted-foreground uppercase outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <ChevronRight className={cn("size-3 shrink-0 transition-transform motion-reduce:transition-none", open && "rotate-90")} aria-hidden />
      <span className="truncate">{label}</span>
      <span className="tabular-nums">{count}</span>
      <span className="h-px flex-1 bg-border" />
    </button>
  );
}

const COLLAPSED_KEY = "sandflow.palette.collapsed";

/** Which palette groups are collapsed (`<tab>:<pack>`), remembered in this browser. */
function useCollapsed() {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        /* storage unavailable — still works for this session */
      }
      return next;
    });
  return { collapsed, toggle };
}

export function Palette() {
  const blocks = useStore((s) => s.data?.blocks ?? []);
  const flows = useStore((s) => s.data?.flows ?? []);
  const packs = useStore((s) => s.data?.packs ?? []);
  const currentFlowId = useStore((s) => s.currentFlowId);
  const { openEditor, setPacksOpen, createFlow } = useStore.getState();
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<PaletteTab>("blocks");
  const input = useRef<HTMLInputElement>(null);
  const { collapsed, toggle } = useCollapsed();

  // Every word must match somewhere (so "git trigger" finds GitHub/GitLab triggers).
  const words = useMemo(() => query.toLowerCase().split(/\s+/).filter(Boolean), [query]);
  const blockMatches = useMemo(
    () => (words.length ? blocks.filter((b) => words.every((w) => blockSearchText(b, blocks).includes(w))) : blocks),
    [blocks, words],
  );
  const flowMatches = useMemo(
    () => (words.length ? flows.filter((f) => words.every((w) => flowSearchText(f, blocks).includes(w))) : flows),
    [flows, blocks, words],
  );

  const searching = words.length > 0;
  const counts: Record<PaletteTab, number> = {
    blocks: blockMatches.filter((b) => !b.isTemplate).length,
    templates: blockMatches.filter((b) => b.isTemplate).length,
    flows: flowMatches.length,
  };

  const empty = (t: PaletteTab) =>
    searching ? (
      <div className="px-1 py-6 text-center text-sm text-muted-foreground">
        No {t} match “{query.trim()}”.
        <button
          type="button"
          className="mt-2 block w-full text-xs text-foreground underline-offset-4 hover:underline"
          onClick={() => {
            setQuery("");
            input.current?.focus();
          }}
        >
          Clear search
        </button>
      </div>
    ) : (
      <div className="px-1 py-6 text-center text-sm text-muted-foreground">No {t} yet.</div>
    );

  /** A collapsible group; a search shows its matches even when it's collapsed. */
  const group = <T,>(t: PaletteTab, g: { key: string; label: string; items: T[] }, render: (item: T) => React.ReactNode) => {
    const key = `${t}:${g.key || "mine"}`;
    const open = searching || !collapsed.has(key);
    return (
      <div key={g.key} className="space-y-1.5">
        <GroupHeader label={g.label} count={g.items.length} open={open} onToggle={() => toggle(key)} />
        {open && g.items.map(render)}
      </div>
    );
  };

  const blockList = (templates: boolean) => {
    const items = blockMatches.filter((b) => b.isTemplate === templates);
    return (
      <ScrollArea className="h-full">
        <div className="space-y-1.5 p-2">
          {grouped(items, packs).map((g) =>
            group(templates ? "templates" : "blocks", g, (b) => <PaletteItem key={b.id} block={b} blocks={blocks} />),
          )}
          {!items.length && empty(templates ? "templates" : "blocks")}
        </div>
      </ScrollArea>
    );
  };

  const flowList = (
    <ScrollArea className="h-full">
      <div className="space-y-1.5 p-2">
        {grouped(flowMatches, packs).map((g) =>
          group("flows", g, (f) => <FlowItem key={f.id} flow={f} blocks={blocks} current={f.id === currentFlowId} />),
        )}
        {!flowMatches.length && empty("flows")}
      </div>
    </ScrollArea>
  );

  const tabLabel = (label: string, t: PaletteTab) => (
    <>
      {label}
      {searching && <span className="text-[10px] text-muted-foreground tabular-nums">{counts[t]}</span>}
    </>
  );

  return (
    <aside className="flex h-full w-[260px] shrink-0 flex-col border-r bg-card/40">
      <Tabs value={tab} onValueChange={(v) => setTab(v as PaletteTab)} className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="space-y-2 p-2">
          <TabsList className="w-full">
            <TabsTrigger value="blocks">{tabLabel("Blocks", "blocks")}</TabsTrigger>
            <TabsTrigger value="templates">{tabLabel("Templates", "templates")}</TabsTrigger>
            <TabsTrigger value="flows">{tabLabel("Flows", "flows")}</TabsTrigger>
          </TabsList>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input
              ref={input}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && query) {
                  e.preventDefault();
                  setQuery("");
                }
              }}
              placeholder="Search blocks, templates and flows"
              aria-label="Search blocks, templates and flows"
              className="h-8 w-full rounded-md border border-input bg-transparent pr-7 pl-7 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 dark:bg-input/30 [&::-webkit-search-cancel-button]:hidden"
            />
            {query && (
              <button
                type="button"
                aria-label="Clear search"
                title="Clear search"
                onClick={() => {
                  setQuery("");
                  input.current?.focus();
                }}
                className="absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        </div>
        <TabsContent value="blocks" className="min-h-0">
          {blockList(false)}
        </TabsContent>
        <TabsContent value="templates" className="min-h-0">
          {blockList(true)}
        </TabsContent>
        <TabsContent value="flows" className="min-h-0">
          {flowList}
        </TabsContent>
      </Tabs>
      <div className="grid grid-cols-2 gap-2 border-t p-2">
        {tab === "flows" ? (
          <Button size="sm" variant="outline" onClick={() => createFlow(`Flow ${flows.filter((f) => !f.pack).length + 1}`)}>
            <Plus /> Flow
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={() => openEditor({ create: tab === "templates" ? "template" : "block" })}>
            <Plus /> {tab === "templates" ? "Template" : "Block"}
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => setPacksOpen(true)} title="Add, update and share packs of blocks and flows">
          <Package /> Packs
        </Button>
      </div>
    </aside>
  );
}
