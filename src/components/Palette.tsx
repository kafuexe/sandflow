import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BlockIcon } from "@/lib/icons";
import { useStore } from "@/lib/store";
import { resolveBlock } from "../../shared/resolve";
import type { BlockDef } from "../../shared/types";
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

export function Palette() {
  const blocks = useStore((s) => s.data?.blocks ?? []);
  const openEditor = useStore((s) => s.openEditor);
  const list = (templates: boolean) => (
    <ScrollArea className="h-full">
      <div className="space-y-1.5 p-2">
        {blocks
          .filter((b) => b.isTemplate === templates)
          .map((b) => (
            <PaletteItem key={b.id} block={b} blocks={blocks} />
          ))}
      </div>
    </ScrollArea>
  );

  return (
    <aside className="flex h-full w-[260px] shrink-0 flex-col border-r bg-card/40">
      <Tabs defaultValue="blocks" className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="p-2">
          <TabsList className="w-full">
            <TabsTrigger value="blocks">Blocks</TabsTrigger>
            <TabsTrigger value="templates">Templates</TabsTrigger>
          </TabsList>
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
