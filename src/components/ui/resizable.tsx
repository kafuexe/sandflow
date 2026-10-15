import { useCallback, useEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { clampSize, dragSize, isVerticalEdge, keyboardSize, loadSize, saveSize, type HandleEdge, type PanelSizeSpec } from "@/lib/panelSize";
import { cn } from "@/lib/utils";

interface ResizableOptions {
  panel: PanelSizeSpec;
  /** The panel edge the handle sits on (e.g. "right" for a left sidebar). */
  edge: HandleEdge;
  /** Accessible name of the handle, e.g. "Resize blocks panel". */
  label: string;
}

/** Size state + handle props for a panel resized by dragging one edge. Sizes persist per panel id. */
export function useResizable({ panel, edge, label }: ResizableOptions) {
  const [size, setSize] = useState(() => loadSize(panel));
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ pointerId: number; startSize: number; startPos: number } | null>(null);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const vertical = isVerticalEdge(edge);

  const commit = useCallback(
    (next: number) => {
      const v = clampSize(next, panel);
      setSize(v);
      saveSize(panel, v);
    },
    [panel],
  );

  // While dragging: no text selection anywhere and the resize cursor even off the handle.
  useEffect(() => {
    if (!dragging) return;
    const body = document.body.style;
    const prev = { userSelect: body.userSelect, cursor: body.cursor };
    body.userSelect = "none";
    body.cursor = vertical ? "col-resize" : "row-resize";
    return () => {
      body.userSelect = prev.userSelect;
      body.cursor = prev.cursor;
    };
  }, [dragging, vertical]);

  const end = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    commit(sizeRef.current);
  };

  const handleProps = {
    role: "separator",
    tabIndex: 0,
    "aria-label": label,
    // A handle between side-by-side panels is a vertical line.
    "aria-orientation": vertical ? "vertical" : "horizontal",
    "aria-valuenow": size,
    "aria-valuemin": panel.min,
    "aria-valuemax": panel.max,
    title: "Drag to resize · double-click to reset",
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || drag.current) return;
      e.preventDefault(); // no text selection / native drag from this gesture
      e.currentTarget.focus();
      e.currentTarget.setPointerCapture(e.pointerId);
      window.getSelection()?.removeAllRanges();
      drag.current = { pointerId: e.pointerId, startSize: sizeRef.current, startPos: vertical ? e.clientX : e.clientY };
      setDragging(true);
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d || d.pointerId !== e.pointerId) return;
      setSize(dragSize(d.startSize, d.startPos, vertical ? e.clientX : e.clientY, edge, panel));
    },
    onPointerUp: end,
    onPointerCancel: end,
    onLostPointerCapture: end,
    onDoubleClick: () => commit(panel.defaultSize),
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      const next = e.key === "Enter" ? panel.defaultSize : keyboardSize(e.key, sizeRef.current, edge, panel, e.shiftKey);
      if (next === null) return;
      e.preventDefault();
      commit(next);
    },
  } as const;

  return { size, dragging, handleProps, reset: () => commit(panel.defaultSize) };
}

const EDGE_CLASS: Record<HandleEdge, string> = {
  left: "inset-y-0 -left-1 w-2 cursor-col-resize",
  right: "inset-y-0 -right-1 w-2 cursor-col-resize",
  top: "inset-x-0 -top-1 h-2 cursor-row-resize",
  bottom: "inset-x-0 -bottom-1 h-2 cursor-row-resize",
};
const LINE_CLASS: Record<HandleEdge, string> = {
  left: "inset-y-0 left-1/2 w-0.5 -translate-x-1/2",
  right: "inset-y-0 left-1/2 w-0.5 -translate-x-1/2",
  top: "inset-x-0 top-1/2 h-0.5 -translate-y-1/2",
  bottom: "inset-x-0 top-1/2 h-0.5 -translate-y-1/2",
};

/** The draggable edge itself; spread `handleProps` from `useResizable` into it. */
export function ResizeHandle({ edge, dragging, handleProps }: { edge: HandleEdge; dragging: boolean; handleProps: ReturnType<typeof useResizable>["handleProps"] }) {
  return (
    <div {...handleProps} data-dragging={dragging || undefined} className={cn("group absolute z-20 touch-none outline-none select-none", EDGE_CLASS[edge])}>
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute rounded-full bg-transparent transition-colors",
          "group-hover:bg-ring/60 group-focus-visible:bg-ring group-data-[dragging]:bg-ring",
          LINE_CLASS[edge],
        )}
      />
    </div>
  );
}

type ResizablePanelProps = ResizableOptions &
  Omit<HTMLAttributes<HTMLElement>, "children"> & {
    as?: "aside" | "div" | "section";
    children: ReactNode;
  };

/** A panel whose width (left/right edge) or height (top/bottom edge) the user can drag. Only this wrapper
 *  re-renders while dragging — `children` keep their identity — so heavy panels stay smooth. */
export function ResizablePanel({ panel, edge, label, as: Tag = "aside", className, style, children, ...rest }: ResizablePanelProps) {
  const { size, dragging, handleProps } = useResizable({ panel, edge, label });
  const sizeStyle: CSSProperties = isVerticalEdge(edge) ? { width: size } : { height: size };
  return (
    <Tag {...rest} className={cn("relative shrink-0", className)} style={{ ...style, ...sizeStyle }}>
      {children}
      <ResizeHandle edge={edge} dragging={dragging} handleProps={handleProps} />
    </Tag>
  );
}
