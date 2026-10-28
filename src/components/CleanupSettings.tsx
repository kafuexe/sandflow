// Settings → Clean up: the branches (and leftover worktrees) finished runs left in your repos. Shows what is safe to
// remove and why the rest is kept; removes only what you tick, each checked again on the server first.

import { useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { CleanupItem, CleanupResult } from "../../shared/types";

export function CleanupSettingsField() {
  const [items, setItems] = useState<CleanupItem[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [results, setResults] = useState<CleanupResult[]>([]);

  const scan = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const { items } = await api.planCleanup();
      setItems(items);
      setPicked(new Set(items.filter((i) => i.removable).map((i) => i.id)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const { results } = await api.applyCleanup([...picked]);
      setResults(results);
      const { items } = await api.planCleanup();
      setItems(items);
      setPicked(new Set());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const removable = items?.filter((i) => i.removable) ?? [];
  const kept = items?.filter((i) => !i.removable) ?? [];

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span>Clean up old run branches</span>
        <Button size="sm" variant="outline" onClick={() => void scan()} disabled={busy}>
          {busy && !items ? <Loader2 className="animate-spin" /> : null} {items ? "Look again" : "Look for leftovers"}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Finds the branches Sandflow made for finished runs (<code>sandflow/…</code> and Box Stack task branches) and their leftover worktrees.
        Only ones whose commits are also on another branch or a remote, with a clean worktree, can be removed. Branches you named are never touched.
      </p>
      {error && <div className="text-xs text-red-400">{error}</div>}
      {results.length > 0 && (
        <ul className="space-y-0.5 text-[11px]">
          {results.map((r) => (
            <li key={r.id} className={r.ok ? "text-emerald-400" : "text-amber-300"}>
              {r.message}
            </li>
          ))}
        </ul>
      )}
      {items && !items.length && <div className="text-xs text-muted-foreground">Nothing left behind.</div>}
      {removable.length > 0 && (
        <div className="space-y-1">
          {removable.map((i) => (
            <label key={i.id} className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={picked.has(i.id)}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(i.id);
                  else next.delete(i.id);
                  setPicked(next);
                }}
              />
              <span className="min-w-0">
                <span className="font-mono">{i.branch}</span> <span className="text-muted-foreground">in {i.repo}</span>
                <span className="block text-[11px] text-muted-foreground">{i.reason}</span>
              </span>
            </label>
          ))}
          <Button size="sm" variant="destructive" onClick={() => void remove()} disabled={busy || !picked.size}>
            <Trash2 /> Remove {picked.size} branch{picked.size === 1 ? "" : "es"}
          </Button>
        </div>
      )}
      {kept.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Kept ({kept.length})</summary>
          <ul className="mt-1 space-y-1">
            {kept.map((i) => (
              <li key={i.id}>
                <span className="font-mono">{i.branch}</span> <span className="text-muted-foreground">— {i.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
