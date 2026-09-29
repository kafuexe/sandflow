import { useMemo, useRef, useState } from "react";
import { Plus, Search, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BlockIcon } from "@/lib/icons";
import { useStore } from "@/lib/store";
import { resolveBlock } from "../../shared/resolve";
import type { BlockDef, ResolvedConfig } from "../../shared/types";
import { DRAG_MIME } from "./FlowCanvas";

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
      title="Drag onto the canvas · click to edit"
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

/** Everything a search can hit for one block: name, kind, description, action, the template it extends, id. */
function searchText(block: BlockDef, blocks: BlockDef[]): string {
  let cfg: ResolvedConfig | undefined;
  try {
    cfg = resolveBlock(block.id, blocks);
  } catch {
    /* cycle — search the raw fields */
  }
  const parent = block.extends ? blocks.find((b) => b.id === block.extends)?.name : "";
  return [block.name, block.id, cfg?.kind, cfg?.description, cfg?.kind === "auto" ? cfg.autoAction : "", parent]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function Palette() {
  const blocks = useStore((s) => s.data?.blocks ?? []);
  const openEditor = useStore((s) => s.openEditor);
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);

  // Every word must match somewhere (so "git trigger" finds GitHub/GitLab triggers).
  const matches = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return blocks;
    return blocks.filter((b) => {
      const text = searchText(b, blocks);
      return words.every((w) => text.includes(w));
    });
  }, [blocks, query]);

  const searching = query.trim().length > 0;
  const count = (templates: boolean) => matches.filter((b) => b.isTemplate === templates).length;

  const list = (templates: boolean) => {
    const items = matches.filter((b) => b.isTemplate === templates);
    return (
      <ScrollArea className="h-full">
        <div className="space-y-1.5 p-2">
          {items.map((b) => (
            <PaletteItem key={b.id} block={b} blocks={blocks} />
          ))}
          {searching && !items.length && (
            <div className="px-1 py-6 text-center text-sm text-muted-foreground">
              No {templates ? "templates" : "blocks"} match “{query.trim()}”.
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
          )}
        </div>
      </ScrollArea>
    );
  };

  const tabLabel = (label: string, templates: boolean) => (
    <>
      {label}
      {searching && <span className="text-[10px] text-muted-foreground tabular-nums">{count(templates)}</span>}
    </>
  );

  return (
    <aside className="flex h-full w-[260px] shrink-0 flex-col border-r bg-card/40">
      <Tabs defaultValue="blocks" className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="space-y-2 p-2">
          <TabsList className="w-full">
            <TabsTrigger value="blocks">{tabLabel("Blocks", false)}</TabsTrigger>
            <TabsTrigger value="templates">{tabLabel("Templates", true)}</TabsTrigger>
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
              placeholder="Search blocks and templates"
              aria-label="Search blocks and templates"
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
          {list(false)}
        </TabsContent>
        <TabsContent value="templates" className="min-h-0">
          {list(true)}
        </TabsContent>
      </Tabs>
      <div className="grid grid-cols-2 gap-2 border-t p-2">
        <Button size="sm" variant="outline" onClick={() => openEditor({ create: "block" })}>
          <Plus /> Block
        </Button>
        <Button size="sm" variant="outline" onClick={() => openEditor({ create: "template" })}>
          <Plus /> Template
        </Button>
      </div>
    </aside>
  );
}
