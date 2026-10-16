import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Ban, Check, ChevronsUpDown, Lock, Plus, Search } from "lucide-react";
import { FLOW_COLORS } from "../../shared/flows";
import type { Flow, FlowColor } from "../../shared/types";
import { FLOW_COLOR_SWATCH, buildSections, highlightSegments, loadRecent, moveActive, pushRecent, saveRecent, type Range } from "@/lib/flowSwitcher";
import { useCurrentFlow, useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const SHORTCUT = isMac ? "⌘K" : "Ctrl K";

/** A flow's colour dot; a hollow ring when it has none. */
export function FlowDot({ color, className }: { color?: FlowColor; className?: string }) {
  return color ? (
    <span aria-hidden className={cn("size-2 shrink-0 rounded-full", className)} style={{ backgroundColor: FLOW_COLOR_SWATCH[color] }} />
  ) : (
    <span aria-hidden className={cn("size-2 shrink-0 rounded-full border border-muted-foreground/50", className)} />
  );
}

function Highlighted({ text, ranges }: { text: string; ranges: Range[] }) {
  if (!ranges.length) return <>{text}</>;
  return (
    <>
      {highlightSegments(text, ranges).map((s, i) =>
        s.match ? (
          <mark key={i} className="rounded-[3px] bg-amber-400/25 text-foreground underline decoration-amber-400/70 underline-offset-2">
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

const Kbd = ({ children }: { children: React.ReactNode }) => (
  <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-border bg-muted px-1 font-sans text-[10px] leading-none font-medium text-muted-foreground">
    {children}
  </kbd>
);

/** Colour picker for one flow: "none" plus the curated palette, as a radio group. */
function ColorRow({ flow }: { flow: Flow }) {
  const setFlowColor = useStore((s) => s.setFlowColor);
  const readOnly = !!flow.pack;
  const options: (FlowColor | undefined)[] = [undefined, ...FLOW_COLORS];
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = Math.max(0, options.indexOf(flow.color));
  return (
    <div className="flex items-center gap-3 border-t px-3 py-2">
      <span className="w-24 shrink-0 truncate text-xs text-muted-foreground" title={readOnly ? "Pack flows are read-only — duplicate it to color it" : `Color of “${flow.name}”`}>
        {readOnly ? (
          <span className="inline-flex items-center gap-1">
            <Lock className="size-3" /> Pack flow
          </span>
        ) : (
          "Flow color"
        )}
      </span>
      <div role="radiogroup" aria-label={`Color of ${flow.name}`} aria-disabled={readOnly || undefined} className="flex flex-1 items-center justify-between">
        {options.map((c, i) => {
          const checked = i === selected;
          return (
            <button
              key={c ?? "none"}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={c ?? "No color"}
              title={c ? c[0].toUpperCase() + c.slice(1) : "No color"}
              disabled={readOnly}
              tabIndex={checked ? 0 : -1}
              onClick={() => setFlowColor(flow.id, c)}
              onKeyDown={(e) => {
                const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
                if (!step) return;
                e.preventDefault();
                const next = (i + step + options.length) % options.length;
                setFlowColor(flow.id, options[next]);
                refs.current[next]?.focus();
              }}
              className={cn(
                "relative flex size-5 items-center justify-center rounded-full outline-none transition-transform",
                "focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-40",
                !readOnly && "hover:scale-110",
                checked && "ring-2 ring-foreground/80 ring-offset-2 ring-offset-popover",
              )}
            >
              {c ? (
                <span className="size-3.5 rounded-full" style={{ backgroundColor: FLOW_COLOR_SWATCH[c] }} />
              ) : (
                <Ban className="size-3.5 text-muted-foreground" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The top bar's flow picker: a trigger showing the current flow that opens a searchable,
 * keyboard-driven list (combobox + listbox), with recents, grouping and per-flow colours.
 */
export function FlowSwitcher({ onNewFlow, className }: { onNewFlow: () => void; className?: string }) {
  const flows = useStore((s) => s.data?.flows) ?? [];
  const flow = useCurrentFlow();
  const currentFlowId = useStore((s) => s.currentFlowId);
  const setCurrentFlow = useStore((s) => s.setCurrentFlow);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [recent, setRecent] = useState<string[]>(loadRecent);

  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const uid = useId();
  const listId = `${uid}-list`;
  const optionId = (id: string) => `${uid}-opt-${id}`;

  // Remember every flow that lands on the canvas, however it got there (here, the palette, a new flow…).
  useEffect(() => {
    if (!currentFlowId) return;
    setRecent((r) => {
      if (r[0] === currentFlowId) return r;
      const next = pushRecent(r, currentFlowId);
      saveRecent(next);
      return next;
    });
  }, [currentFlowId]);

  const sections = useMemo(() => buildSections(flows, query, recent), [flows, query, recent]);
  const items = useMemo(() => sections.flatMap((s) => s.items), [sections]);
  const ownCount = flows.filter((f) => !f.pack).length;

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const show = () => {
    setQuery("");
    setOpen(true);
  };
  const choose = (id: string) => {
    setCurrentFlow(id);
    close();
  };

  // On open (and on every new query) highlight the best candidate: the current flow, or the top result.
  useEffect(() => {
    if (!open) return;
    const at = query.trim() ? 0 : items.findIndex((it) => it.flow.id === currentFlowId);
    setActive(items.length ? Math.max(0, at) : -1);
    // Re-run only on open / query changes (items follow the query), so live data updates don't move the highlight.
  }, [open, query]);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  // Keep the highlighted option visible while arrowing through a long list.
  useEffect(() => {
    const id = items[active]?.flow.id;
    if (!open || !id) return;
    document.getElementById(optionId(id))?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  // Close on a click outside.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  // Ctrl/Cmd+K toggles the switcher from anywhere in the builder.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "k" || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      // Not from behind a dialog (block editor, settings…): the list would open where it can't be seen or focused.
      if (!open && document.querySelector('[role="dialog"][data-state="open"]')) return;
      e.preventDefault();
      if (open) close();
      else show();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || ((e.key === "Home" || e.key === "End") && e.ctrlKey)) {
      e.preventDefault();
      setActive((i) => moveActive(i, items.length, e.key));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = items[active];
      if (it) choose(it.flow.id);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  const activeId = items[active]?.flow.id;
  let index = -1;

  return (
    <div
      ref={root}
      className={cn("relative", className)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.preventDefault();
          close();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-keyshortcuts="Control+K Meta+K"
        title={`Switch flow (${SHORTCUT})`}
        onClick={() => (open ? close() : show())}
        className={cn(
          "group flex h-8 w-60 items-center gap-2 rounded-md border border-input bg-transparent pr-2 pl-2.5 text-left text-sm shadow-xs transition-[color,box-shadow,background-color] outline-none",
          "hover:bg-accent/60 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30 dark:hover:bg-input/50",
          open && "border-ring/60 dark:bg-input/50",
        )}
      >
        {flow ? <FlowDot color={flow.color} /> : null}
        <span className={cn("min-w-0 flex-1 truncate", !flow && "text-muted-foreground")}>{flow?.name ?? "No flows"}</span>
        {flow?.pack && <span className="shrink-0 rounded border px-1 text-[10px] leading-4 text-muted-foreground">{flow.pack}</span>}
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <div
          className="absolute top-full left-0 z-50 mt-1.5 flex w-[22rem] origin-top-left flex-col overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg shadow-black/20 animate-in fade-in-0 zoom-in-95 slide-in-from-top-1"
          onBlur={(e) => {
            // Tabbing out of the panel (not to the trigger) closes it.
            const to = e.relatedTarget as Node | null;
            if (to && !root.current?.contains(to)) close(false);
          }}
        >
          <div className="flex items-center gap-2 border-b px-3">
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <input
              ref={input}
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeId ? optionId(activeId) : undefined}
              aria-label="Search flows"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onInputKey}
              placeholder={`Search ${flows.length} flow${flows.length === 1 ? "" : "s"}…`}
              spellCheck={false}
              autoComplete="off"
              className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <Kbd>Esc</Kbd>
          </div>

          <div id={listId} role="listbox" aria-label="Flows" className="max-h-[min(60vh,22rem)] overflow-y-auto overscroll-contain p-1">
            {items.length === 0 ? (
              <div className="flex flex-col items-center gap-1 px-4 py-8 text-center">
                <Search className="mb-1 size-5 text-muted-foreground/60" aria-hidden />
                <p className="text-sm">{flows.length ? "No flows match" : "No flows yet"}</p>
                <p className="text-xs text-muted-foreground">
                  {flows.length ? (
                    <>
                      Nothing named “<span className="text-foreground">{query.trim()}</span>”.
                    </>
                  ) : (
                    "Create one to get started."
                  )}
                </p>
              </div>
            ) : (
              sections.map((s) => (
                <div key={s.key} role="group" aria-labelledby={`${uid}-${s.key}`} className="not-first:mt-1.5">
                  <div id={`${uid}-${s.key}`} className="flex items-center justify-between px-2 pt-1.5 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                    <span>{s.label}</span>
                    <span className="tabular-nums normal-case">{s.items.length}</span>
                  </div>
                  {s.items.map(({ flow: f, ranges }) => {
                    index += 1;
                    const i = index;
                    const isActive = i === active;
                    const isCurrent = f.id === currentFlowId;
                    const blocks = f.nodes.length;
                    return (
                      <div
                        key={f.id}
                        id={optionId(f.id)}
                        role="option"
                        aria-selected={isActive}
                        aria-current={isCurrent || undefined}
                        onMouseMove={() => i !== active && setActive(i)}
                        onPointerDown={(e) => e.preventDefault() /* keep focus in the search box */}
                        onClick={() => choose(f.id)}
                        className={cn(
                          "flex h-8 cursor-default items-center gap-2.5 rounded-md px-2 text-sm select-none",
                          isActive ? "bg-accent text-accent-foreground" : "text-foreground/90",
                        )}
                      >
                        <FlowDot color={f.color} />
                        <span className={cn("min-w-0 flex-1 truncate", isCurrent && "font-medium")}>
                          <Highlighted text={f.name} ranges={ranges} />
                        </span>
                        {f.pack && <span className="shrink-0 rounded border px-1 text-[10px] leading-4 text-muted-foreground">{f.pack}</span>}
                        <span className="w-14 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">
                          {blocks ? `${blocks} block${blocks === 1 ? "" : "s"}` : "empty"}
                        </span>
                        <Check className={cn("size-3.5 shrink-0", isCurrent ? "text-foreground" : "invisible")} aria-hidden />
                        {isCurrent && <span className="sr-only">(current)</span>}
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>

          {flow && <ColorRow flow={flow} />}

          <div className="flex items-center gap-3 border-t bg-muted/30 px-2 py-1.5">
            <button
              type="button"
              onClick={() => {
                close(false);
                onNewFlow();
              }}
              className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium whitespace-nowrap outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <Plus className="size-3.5" /> New flow
            </button>
            <span className="text-[11px] whitespace-nowrap text-muted-foreground tabular-nums" title={`${ownCount} yours · ${flows.length - ownCount} from packs`}>
              {flows.length} flow{flows.length === 1 ? "" : "s"}
            </span>
            <span className="ml-auto hidden items-center gap-1 text-[11px] whitespace-nowrap text-muted-foreground sm:flex">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> move <Kbd>↵</Kbd> open
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
