// Integrations: other harnesses (CLIs that take a task all the way to an MR) your flows can drive. Each one's
// actions are blocks in the palette. Import them like packs (a link, folder or zip), or write your own as JSON.

import { useEffect, useState } from "react";
import { AlertTriangle, Check, Copy, ExternalLink, Loader2, Package, Pencil, Plug, Plus, RefreshCw, ShieldAlert, ShieldCheck, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { BlockIcon } from "@/lib/icons";
import { useStore } from "@/lib/store";
import { actionOptions, commandPathEnv, installCommand, integrationProblems, integrationTemplate, isLocalIntegrationPack } from "../../shared/integrations";
import type { IntegrationDef, IntegrationInfo, IntegrationStatus } from "../../shared/types";

/** Platform key the browser runs on (for the install command to show). */
function browserPlatform(): string {
  const ua = navigator.userAgent;
  return /Windows/i.test(ua) ? "win32" : /Mac/i.test(ua) ? "darwin" : "linux";
}

function ErrorNote({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <div role="alert" className="rounded border border-red-500/60 bg-red-500/10 p-2 text-xs text-red-300">
      {text}
    </div>
  );
}

function CopyLine({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="flex items-start gap-1 rounded border bg-muted/40 p-1.5">
      <code className="min-w-0 flex-1 break-all text-[11px]">{text}</code>
      <button
        type="button"
        title="Copy"
        aria-label="Copy command"
        className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          });
        }}
      >
        {done ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}

function StatusBadge({ status, checking }: { status?: IntegrationStatus; checking: boolean }) {
  if (checking && !status) {
    return (
      <Badge variant="outline" className="gap-1 text-[10px]">
        <Loader2 className="size-3 animate-spin" /> checking
      </Badge>
    );
  }
  if (!status) return null;
  return status.installed ? (
    <Badge className="gap-1 bg-emerald-500/20 text-[10px] text-emerald-300" title={status.path}>
      <Check className="size-3" /> installed{status.version ? ` · ${status.version}` : ""}
    </Badge>
  ) : (
    <Badge className="gap-1 bg-amber-500/20 text-[10px] text-amber-200" title={status.error}>
      <X className="size-3" /> not found
    </Badge>
  );
}

function IntegrationCard({
  info,
  status,
  checking,
  onCheck,
  onEdit,
}: {
  info: IntegrationInfo;
  status?: IntegrationStatus;
  checking: boolean;
  onCheck: () => void;
  onEdit: () => void;
}) {
  const packs = useStore((s) => s.data?.packs ?? []);
  const flows = useStore((s) => s.data?.flows ?? []);
  const [error, setError] = useState<string>();
  const { def } = info;
  const local = isLocalIntegrationPack(info.pack);
  const pack = packs.find((p) => p.id === info.pack);
  const install = installCommand(def, browserPlatform());
  // Your flows that would break without it.
  const usedBy = flows.filter((f) => !f.pack && f.nodes.some((n) => n.data.blockId.startsWith(`${info.id}-`)));

  const act = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await fn();
      await useStore.getState().reload();
      onCheck();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md" style={{ background: `${def.color ?? "#0ea5e9"}33` }}>
          <BlockIcon name={def.icon ?? "plug"} className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium">{def.name}</span>
            <Badge variant="outline" className="font-mono text-[10px]">
              {def.command}
            </Badge>
            <StatusBadge status={status} checking={checking} />
          </div>
          {def.description && <p className="mt-0.5 text-xs text-muted-foreground">{def.description}</p>}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              {local ? (
                "Yours"
              ) : (
                <>
                  <Package className="size-3" /> {pack ? `${pack.name} · ${pack.version}` : info.pack} pack
                </>
              )}
            </span>
            {def.homepage && (
              <a href={def.homepage} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground hover:underline">
                {def.homepage.replace(/^https?:\/\//, "")} <ExternalLink className="size-3" />
              </a>
            )}
            {usedBy.length > 0 && <span>Used by {usedBy.length} flow{usedBy.length === 1 ? "" : "s"}</span>}
          </div>
        </div>
      </div>

      {info.problems.length > 0 && (
        <ul className="space-y-0.5 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-200">
          {info.problems.map((p) => (
            <li key={p} className="flex gap-1.5">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" /> {p}
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-1 text-xs">
        <div className="text-[11px] font-medium text-muted-foreground uppercase">Blocks</div>
        {def.actions.map((a) => {
          const opts = actionOptions(def, a);
          return (
            <div key={a.id} className="flex items-start gap-2">
              <BlockIcon name={a.icon ?? def.icon ?? "plug"} className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <span>{a.name}</span>
                <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">
                  {def.command} {a.args.join(" ")}
                </span>
                {(a.description || opts.length > 0) && (
                  <div className="text-[11px] text-muted-foreground">
                    {a.description}
                    {opts.length > 0 && ` Options: ${opts.map((o) => o.label).join(", ")}.`}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        <p className="text-[11px] text-muted-foreground">Drag them from the Blocks tab onto the canvas.</p>
      </div>

      {status && !status.installed && info.trusted && (
        <div className="space-y-1.5 rounded border border-amber-500/30 p-2 text-xs">
          <div className="text-amber-200">{status.error}</div>
          {install && <CopyLine text={install} />}
          {def.install?.notes && <p className="text-[11px] text-muted-foreground">{def.install.notes}</p>}
          {def.install?.url && (
            <a href={def.install.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] hover:underline">
              Install instructions <ExternalLink className="size-3" />
            </a>
          )}
          <p className="text-[11px] text-muted-foreground">
            Installed somewhere else? Set <code>{commandPathEnv(def.command)}</code> to the executable before starting Sandflow.
          </p>
        </div>
      )}

      {!local && pack && (
        <label className="flex items-center justify-between gap-2 rounded border p-2 text-xs">
          <span className="flex items-center gap-1.5">
            {pack.trustHost ? <ShieldCheck className="size-3.5 text-emerald-400" /> : <ShieldAlert className="size-3.5 text-amber-400" />}
            {pack.trustHost ? `May run ${def.command} on this machine` : `Not allowed to run ${def.command} on this machine yet`}
          </span>
          <Switch
            checked={pack.trustHost}
            onCheckedChange={(v) => {
              if (v && !confirm(`Let the "${pack.name}" pack run ${def.command} (and its other code) on this machine, with your login?`)) return;
              void act(() => api.setPackTrust(pack.id, v));
            }}
          />
        </label>
      )}

      <ErrorNote text={error} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={checking || !info.trusted} onClick={onCheck}>
          <RefreshCw className={checking ? "animate-spin" : undefined} /> Check again
        </Button>
        {local && (
          <>
            <Button size="sm" variant="outline" onClick={onEdit}>
              <Pencil /> Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-red-400 hover:text-red-300"
              onClick={() => {
                const warn = usedBy.length ? `\n\nThese flows use it and will show missing blocks: ${usedBy.map((f) => f.name).join(", ")}` : "";
                if (confirm(`Delete the "${def.name}" integration?${warn}`)) void act(() => api.deleteIntegration(def.id));
              }}
            >
              <Trash2 /> Delete
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/** Write or edit one of your own integrations as JSON. */
function Editor({ initial, previousId, onDone }: { initial: IntegrationDef; previousId?: string; onDone: () => void }) {
  const [text, setText] = useState(() => JSON.stringify(initial, null, 2));
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    let def: IntegrationDef;
    try {
      def = JSON.parse(text) as IntegrationDef;
    } catch (e) {
      setErrors([`Invalid JSON: ${(e as Error).message}`]);
      return;
    }
    const bad = integrationProblems(def);
    if (bad.length) return setErrors(bad);
    setBusy(true);
    try {
      await api.saveIntegration(def, previousId);
      await useStore.getState().reload();
      onDone();
    } catch (e) {
      setErrors([(e as Error).message]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        <code>command</code> is the harness's executable; each action's <code>args</code> follow it. Templates:{" "}
        <code>{"{{input}}"}</code> (the incoming artifact, else the starting prompt), <code>{"{{prompt}}"}</code>, <code>{"{{env.NAME}}"}</code>,{" "}
        <code>{"{{option.id}}"}</code>, <code>{"{{worktree}}"}</code>, <code>{"{{trigger.url}}"}</code>. An option's <code>args</code> are added when it's set (
        <code>{"{{value}}"}</code> is its value). <code>exitCodes</code> map exit codes to the block's exits.
      </p>
      <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={22} spellCheck={false} className="font-mono text-xs" aria-label="Integration JSON" />
      {errors.length > 0 && (
        <ul role="alert" className="space-y-0.5 rounded border border-red-500/60 bg-red-500/10 p-2 text-xs text-red-300">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Button size="sm" disabled={busy} onClick={() => void save()}>
          {busy ? <Loader2 className="animate-spin" /> : <Check />} Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function IntegrationsDialog() {
  const open = useStore((s) => s.integrationsOpen);
  const integrations = useStore((s) => s.data?.integrations ?? []);
  const { setIntegrationsOpen, setPacksOpen } = useStore.getState();
  const [statuses, setStatuses] = useState<Record<string, IntegrationStatus>>({});
  const [checking, setChecking] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ def: IntegrationDef; previousId?: string } | null>(null);

  const check = async (id: string, force: boolean) => {
    setChecking((c) => new Set(c).add(id));
    try {
      const s = await api.integrationStatus(id, force);
      setStatuses((x) => ({ ...x, [id]: s }));
    } catch (e) {
      setStatuses((x) => ({ ...x, [id]: { id, installed: false, error: (e as Error).message, checkedAt: Date.now() } }));
    } finally {
      setChecking((c) => {
        const n = new Set(c);
        n.delete(id);
        return n;
      });
    }
  };

  const ids = integrations.map((i) => `${i.id}:${i.trusted}`).join(",");
  useEffect(() => {
    if (!open) {
      setEditing(null);
      return;
    }
    for (const i of useStore.getState().data?.integrations ?? []) void check(i.id, false);
  }, [open, ids]);

  return (
    <Dialog open={open} onOpenChange={setIntegrationsOpen}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 p-0 sm:max-w-3xl">
        <DialogHeader className="border-b p-4">
          <DialogTitle className="flex items-center gap-2">
            <Plug className="size-5" /> Integrations
          </DialogTitle>
          <DialogDescription>
            Other harnesses your flows can drive — tools that take a task all the way to an MR on their own. Each action is a block; it runs on this machine with your login.
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="flex min-h-0 flex-1 flex-col" viewportClassName="min-h-0 flex-1">
          <div className="space-y-3 p-4">
            {editing ? (
              <Editor key={editing.previousId ?? "new"} initial={editing.def} previousId={editing.previousId} onDone={() => setEditing(null)} />
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    title="Integrations come in packs: add one from a GitHub / GitLab link, a folder or a zip"
                    onClick={() => {
                      setIntegrationsOpen(false);
                      setPacksOpen(true, "add");
                    }}
                  >
                    <Package /> Import from a link, folder or zip
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setEditing({ def: integrationTemplate() })}>
                    <Plus /> New integration
                  </Button>
                </div>
                {integrations.map((i) => (
                  <IntegrationCard
                    key={i.id}
                    info={i}
                    status={statuses[i.id]}
                    checking={checking.has(i.id)}
                    onCheck={() => void check(i.id, true)}
                    onEdit={() => setEditing({ def: structuredClone(i.def), previousId: i.def.id })}
                  />
                ))}
                {!integrations.length && (
                  <div className="py-6 text-center text-sm text-muted-foreground">
                    No integrations yet. Import a pack that brings one (it has an <code>integrations/</code> folder), or write your own.
                  </div>
                )}
              </>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
