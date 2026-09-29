import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/** Collapsible block of text (agent output, artifacts, context). */
export function Disclosure({ title, body, open, mono = true }: { title: React.ReactNode; body: string; open?: boolean; mono?: boolean }) {
  return (
    <details open={open} className="group/d">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded text-xs text-muted-foreground outline-none select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 transition-transform group-open/d:rotate-90 motion-reduce:transition-none" />
        {title}
      </summary>
      <pre
        className={cn(
          "mt-1.5 max-h-80 overflow-auto rounded-md bg-black/30 p-3 text-xs leading-relaxed whitespace-pre-wrap",
          mono ? "font-mono" : "font-sans",
        )}
      >
        {body}
      </pre>
    </details>
  );
}
