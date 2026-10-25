import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ArrowDown, Brain, ChevronRight, CornerDownRight, Loader2, MessageSquare, Wrench } from "lucide-react";
import { DEFAULT_FILTER, groupActivity, loadFilter, loadOpen, saveFilter, saveOpen, shown, type ActivityFilter } from "@/lib/activityView";
import { cn } from "@/lib/utils";
import type { AgentActivity } from "../../shared/activity";

/** A section with a header button that shows / hides its body; the open state is remembered per `id`. */
export function CollapsibleSection({
  id,
  title,
  meta,
  actions,
  defaultOpen = true,
  children,
}: {
  id: string;
  title: string;
  /** Shown after the title, e.g. a count. */
  meta?: ReactNode;
  /** Controls on the right of the header (only while open). */
  actions?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => loadOpen(id, defaultOpen));
  const bodyId = useId();
  const headId = useId();
  return (
    <section className="space-y-1" aria-labelledby={headId}>
      <div className="flex min-h-6 items-center gap-2">
        <button
          id={headId}
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => {
            setOpen(!open);
            saveOpen(id, !open);
          }}
          className="flex items-center gap-1 rounded text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <ChevronRight className={cn("size-3.5 transition-transform motion-reduce:transition-none", open && "rotate-90")} aria-hidden />
          {title}
          {meta !== undefined && <span className="font-normal text-muted-foreground/70">{meta}</span>}
        </button>
        {open && actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
      </div>
      <div id={bodyId} role="region" aria-labelledby={headId} hidden={!open}>
        {open && children}
      </div>
    </section>
  );
}

// One filter for every activity view (Run tab, each Agent screen step), remembered across reloads.
let currentFilter: ActivityFilter | undefined;
const filterListeners = new Set<() => void>();
const getFilter = () => (currentFilter ??= loadFilter());
const subscribeFilter = (fn: () => void) => {
  filterListeners.add(fn);
  return () => void filterListeners.delete(fn);
};

/** The activity filter shared by every activity view. */
export function useActivityFilter() {
  const filter = useSyncExternalStore(subscribeFilter, getFilter);
  const toggle = useCallback((k: keyof ActivityFilter) => {
    const f = getFilter();
    currentFilter = { ...f, [k]: !f[k] };
    saveFilter(currentFilter);
    filterListeners.forEach((fn) => fn());
  }, []);
  return { filter, toggle };
}

const FILTERS: { key: keyof ActivityFilter; label: string; icon: ReactNode }[] = [
  { key: "thinking", label: "Thinking", icon: <Brain className="size-3" aria-hidden /> },
  { key: "text", label: "Replies", icon: <MessageSquare className="size-3" aria-hidden /> },
  { key: "tools", label: "Tools", icon: <Wrench className="size-3" aria-hidden /> },
];

/** Toggle buttons choosing which kinds of activity are shown. */
export function ActivityFilterBar({ filter, toggle }: ReturnType<typeof useActivityFilter>) {
  return (
    <div role="group" aria-label="Show activity" className="flex items-center gap-1">
      {FILTERS.map((f) => (
        <button
          key={f.key}
          type="button"
          aria-pressed={filter[f.key]}
          onClick={() => toggle(f.key)}
          title={`${filter[f.key] ? "Hide" : "Show"} ${f.label.toLowerCase()}`}
          className={cn(
            "flex h-5 items-center gap-1 rounded-full border px-1.5 text-[10px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
            filter[f.key] ? "border-sky-400/40 bg-sky-400/10 text-foreground" : "border-border text-muted-foreground/70 line-through",
          )}
        >
          {f.icon}
          {f.label}
        </button>
      ))}
    </div>
  );
}

/** One thing the agent did. */
export function ActivityRow({ a }: { a: AgentActivity }) {
  switch (a.kind) {
    case "thinking":
      return (
        <div className="flex gap-1.5 text-muted-foreground italic">
          <Brain className="mt-0.5 size-3 shrink-0 opacity-70" aria-label="Thinking" />
          <p className="min-w-0 whitespace-pre-wrap">{a.text}</p>
        </div>
      );
    case "text":
      return (
        <div className="flex gap-1.5 text-foreground">
          <MessageSquare className="mt-0.5 size-3 shrink-0 text-sky-300/80" aria-label="Reply" />
          <p className="min-w-0 whitespace-pre-wrap">{a.text.trim()}</p>
        </div>
      );
    case "tool":
      return (
        <div className="flex min-w-0 items-center gap-1.5">
          <Wrench className="size-3 shrink-0 text-amber-300/80" aria-label="Tool call" />
          <span className="shrink-0 rounded bg-amber-400/10 px-1.5 py-px font-mono text-[10px] text-amber-200">{a.name}</span>
          {a.text && (
            <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground" title={a.text}>
              {a.text}
            </span>
          )}
        </div>
      );
    case "tool_result":
      return (
        <div className={cn("flex min-w-0 items-center gap-1.5 pl-4 font-mono text-[10px]", a.isError ? "text-red-300" : "text-muted-foreground/70")}>
          <CornerDownRight className="size-3 shrink-0" aria-label={a.isError ? "Tool error" : "Tool result"} />
          <span className="min-w-0 truncate" title={a.text}>
            {a.text}
          </span>
        </div>
      );
    case "result":
      return <div className={cn("text-[10px] font-medium", a.isError ? "text-red-300" : "text-emerald-300")}>{a.text}</div>;
  }
}

/** Keeps a scroller at the bottom as content grows, unless the user scrolled up to read. */
export function useFollow(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [away, setAway] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [dep]);
  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setAway(!pinned.current);
  };
  const jump = () => {
    const el = ref.current;
    if (!el) return;
    pinned.current = true;
    setAway(false);
    el.scrollTop = el.scrollHeight;
  };
  return { ref, onScroll, away, jump };
}

/** "Jump to latest" for a scroller the user scrolled up in. */
export function JumpButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute right-3 bottom-2 z-10 flex items-center gap-1 rounded-full border bg-background/90 px-2 py-0.5 text-[10px] text-muted-foreground shadow outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <ArrowDown className="size-3" aria-hidden /> Latest
    </button>
  );
}

const EMPTY = "Nothing yet — the thinking, replies and tool calls of agent blocks show up here while they run.";

/**
 * Every agent node's activity, grouped by node (in the order they started). Follows new activity unless the user
 * scrolled up. Fills its parent's height.
 */
export function ActivityFeed({
  activity,
  label,
  running,
  filter = DEFAULT_FILTER,
}: {
  activity: Record<string, AgentActivity[]> | undefined;
  label: (nodeKey: string) => string;
  /** Node keys still running (a spinner next to their name). */
  running?: (nodeKey: string) => boolean;
  filter?: ActivityFilter;
}) {
  const groups = groupActivity(activity, filter);
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const last = groups.at(-1)?.items.at(-1);
  const { ref, onScroll, away, jump } = useFollow(`${total}:${last?.ts}:${last?.text.length}`);
  return (
    <div className="relative h-full">
      <div ref={ref} onScroll={onScroll} aria-live="off" className="h-full space-y-3 overflow-auto rounded bg-black/40 p-2 text-[11px] leading-relaxed">
        {groups.length === 0 && <p className="text-muted-foreground">{Object.keys(activity ?? {}).length ? "Everything is filtered out." : EMPTY}</p>}
        {groups.map((g) => (
          <div key={g.nodeKey} className="space-y-1">
            <div className="sticky -top-2 z-[1] -mx-2 flex items-center gap-1.5 border-b border-border/60 bg-background px-2 py-1 text-[10px] font-medium text-sky-300">
              {running?.(g.nodeKey) && <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-label="Running" />}
              {label(g.nodeKey)}
            </div>
            {g.items.map((a, i) => (
              <ActivityRow key={`${a.ts}-${i}`} a={a} />
            ))}
          </div>
        ))}
      </div>
      {away && <JumpButton onClick={jump} />}
    </div>
  );
}

/** One node's activity during one execution, as a flat list (Agent screen steps). */
export function ActivityList({ items, filter }: { items: AgentActivity[]; filter: ActivityFilter }) {
  const visible = items.filter((a) => shown(a, filter));
  const last = visible.at(-1);
  const { ref, onScroll, away, jump } = useFollow(`${visible.length}:${last?.ts}:${last?.text.length}`);
  // Opening a long list starts at its end, like the live view.
  useEffect(() => jump(), []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="relative">
      <div ref={ref} onScroll={onScroll} className="max-h-80 space-y-1 overflow-auto rounded-md bg-black/30 p-3 text-xs leading-relaxed">
        {visible.length ? visible.map((a, i) => <ActivityRow key={`${a.ts}-${i}`} a={a} />) : <p className="text-muted-foreground">Everything is filtered out.</p>}
      </div>
      {away && <JumpButton onClick={jump} />}
    </div>
  );
}
