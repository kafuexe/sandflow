// Packs: install blocks + flows others shared (GitHub, GitLab, a folder or a zip), review what they do first,
// keep them updated, and share your own as a pack.

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Download,
  ExternalLink,
  FolderOpen,
  GitBranch,
  Link2,
  Loader2,
  Package,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api, type PackFrom } from "@/lib/api";
import { desktop } from "@/lib/desktop";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { BASE_PACK_URL, PACK_ID_RE, packOf, packSourceLabel, packSourceUrl } from "../../shared/packs";
import { resolveBlock } from "../../shared/resolve";
import type { BlockDef, Flow, PackInfo, PackPreview, PackRisk } from "../../shared/types";

type Tab = "installed" | "add" | "share";

const RISK_LABEL: Record<PackRisk["kind"], string> = {
  script: "Script (container)",
  "host-script": "Script on this machine",
  shell: "Shell command on this machine",
  setup: "Setup step",
  bin: "Executable",
  dockerfile: "Builds an image",
  image: "Container image",
};

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error ?? new Error("Couldn't read the file"));
    r.readAsDataURL(file);
  });
}

function downloadBase64(name: string, b64: string) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const kb = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

function ErrorNote({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <div role="alert" className="rounded border border-red-500/60 bg-red-500/10 p-2 text-xs text-red-300">
      {text}
    </div>
  );
}

// ---------- installed ----------

function PackCard({ pack, onUpdate, busy }: { pack: PackInfo; onUpdate: (id: string) => void; busy: boolean }) {
  const flows = useStore((s) => s.data?.flows ?? []);
  const [error, setError] = useState<string>();
  const url = packSourceUrl(pack.source);
  // Your flows that would break if this pack went away.
  const usedBy = flows.filter((f) => !f.pack && f.nodes.some((n) => packOf(n.data.blockId) === pack.id || packOf(n.data.overrides?.subflow?.flowId ?? "") === pack.id));
  const linked = pack.source.type === "folder" && pack.source.link;
  const canUpdate = pack.source.type !== "zip";

  const act = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await fn();
      await useStore.getState().reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex items-start gap-2">
        <Package className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium">{pack.name}</span>
            <Badge variant="secondary" className="font-mono text-[10px]">
              {pack.version}
            </Badge>
            <Badge variant="outline" className="font-mono text-[10px]">
              {pack.id}
            </Badge>
            {linked && <Badge className="bg-sky-500/20 text-[10px] text-sky-300">linked</Badge>}
          </div>
          {pack.description && <p className="mt-0.5 text-xs text-muted-foreground">{pack.description}</p>}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
            <span>
              {pack.blockCount} blocks · {pack.flowCount} flows · {pack.skillCount} skills
            </span>
            {url ? (
              <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground hover:underline">
                {packSourceLabel(pack.source)} <ExternalLink className="size-3" />
              </a>
            ) : (
              <span className="truncate">{packSourceLabel(pack.source)}</span>
            )}
            {pack.commit && <span className="font-mono">@{pack.commit.slice(0, 7)}</span>}
          </div>
        </div>
      </div>

      {pack.problems.length > 0 && (
        <ul className="space-y-0.5 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-200">
          {pack.problems.map((p) => (
            <li key={p} className="flex gap-1.5">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" /> {p}
            </li>
          ))}
        </ul>
      )}

      {pack.hasCode && (
        <label className="flex items-center justify-between gap-2 rounded border p-2 text-xs">
          <span className="flex items-center gap-1.5">
            {pack.trustHost ? <ShieldCheck className="size-3.5 text-emerald-400" /> : <ShieldAlert className="size-3.5 text-amber-400" />}
            {pack.trustHost ? "May run code on this machine" : "Its code only runs in containers"}
          </span>
          <Switch
            checked={pack.trustHost}
            onCheckedChange={(v) => {
              if (v && !confirm(`Let "${pack.name}" run its scripts and shell commands directly on this machine (outside a container)?`)) return;
              void act(() => api.setPackTrust(pack.id, v));
            }}
          />
        </label>
      )}

      <ErrorNote text={error} />
      <div className="flex flex-wrap gap-2">
        {canUpdate && !linked && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onUpdate(pack.id)}>
            <RefreshCw /> Check for update
          </Button>
        )}
        {linked && (
          <Button size="sm" variant="outline" onClick={() => void act(() => api.reloadPack(pack.id))}>
            <RefreshCw /> Reload
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="text-red-400 hover:text-red-300"
          onClick={() => {
            const warn = usedBy.length ? `\n\nThese flows use it and will show missing blocks: ${usedBy.map((f) => f.name).join(", ")}` : "";
            if (confirm(`Remove the "${pack.name}" pack?${warn}`)) void act(() => api.removePack(pack.id));
          }}
        >
          <Trash2 /> Remove
        </Button>
        {usedBy.length > 0 && <span className="self-center text-[11px] text-muted-foreground">Used by {usedBy.length} of your flows</span>}
      </div>
    </div>
  );
}

// ---------- review (before installing) ----------

function Review({
  preview,
  onInstalled,
  onCancel,
  onPreview,
}: {
  preview: PackPreview;
  onInstalled: () => void;
  onCancel: () => void;
  /** Stage another pack (a missing dependency, or an update for a conflicting one). */
  onPreview: (from: PackFrom) => void;
}) {
  const installed = useStore((s) => s.data?.packs ?? []);
  const p = preview;
  const m = p.manifest;
  const codeUnchanged = p.existing && p.changes && !p.changes.codeChanged;
  const [trustHost, setTrustHost] = useState(p.needsHost && !!p.existing?.trustHost && !!codeUnchanged);
  const differentSource = p.existing && p.existing.source.type !== "bundled" && JSON.stringify({ ...p.existing.source, ref: undefined }) !== JSON.stringify({ ...p.source, ref: undefined });
  const [replace, setReplace] = useState(false);
  const blocked = p.missing.length > 0 || p.conflicts.length > 0;
  const [anyway, setAnyway] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const unchanged = p.existing && p.existing.hash === p.hash;

  const install = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.installPack(p.token, { trustHost, replace: !!differentSource && replace });
      await useStore.getState().reload();
      onInstalled();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2">
        <Package className="mt-1 size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-base font-semibold">{m.name}</span>
            <Badge variant="secondary" className="font-mono text-[10px]">
              {m.version}
            </Badge>
            <Badge variant="outline" className="font-mono text-[10px]">
              {m.id}
            </Badge>
          </div>
          {m.description && <p className="text-xs text-muted-foreground">{m.description}</p>}
          <div className="mt-1 text-[11px] text-muted-foreground">
            {packSourceLabel(p.source)}
            {p.commit && <span className="font-mono"> @{p.commit.slice(0, 7)}</span>} · {p.fileCount} files · {kb(p.totalBytes)}
            {m.author && <> · by {m.author}</>}
          </div>
        </div>
      </div>

      {p.existing && (
        <div className="rounded-lg border p-2 text-xs">
          {unchanged ? (
            <span className="text-muted-foreground">Already up to date ({p.existing.version}).</span>
          ) : (
            <>
              Updates <b>{m.id}</b> from {p.existing.version} to {m.version}.
              {p.changes && (
                <span className="text-muted-foreground">
                  {" "}
                  {p.changes.added.length} added · {p.changes.changed.length} changed · {p.changes.removed.length} removed files.
                </span>
              )}
              {p.changes?.codeChanged && p.existing.trustHost && (
                <div className="mt-1 text-amber-300">Its code changed, so it has to be allowed to run on this machine again.</div>
              )}
              {p.changes && (p.changes.added.length + p.changes.changed.length + p.changes.removed.length > 0) && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-muted-foreground">Changed files</summary>
                  <ul className="mt-1 max-h-32 overflow-y-auto font-mono text-[10px]">
                    {p.changes.added.map((f) => <li key={`a${f}`} className="text-emerald-400">+ {f}</li>)}
                    {p.changes.changed.map((f) => <li key={`c${f}`} className="text-sky-300">~ {f}</li>)}
                    {p.changes.removed.map((f) => <li key={`r${f}`} className="text-red-400">- {f}</li>)}
                  </ul>
                </details>
              )}
            </>
          )}
          {differentSource && (
            <label className="mt-2 flex items-center gap-2 text-amber-300">
              <Switch checked={replace} onCheckedChange={setReplace} />
              Replace the "{m.id}" pack installed from {packSourceLabel(p.existing.source)}
            </label>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 text-xs">
        <div className="space-y-1 rounded-lg border p-2">
          <div className="font-medium">Blocks ({p.blocks.length})</div>
          <div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto">
            {p.blocks.map((b) => (
              <Badge key={b.id} variant="outline" className="text-[10px] font-normal">
                {b.name}
                {b.isTemplate && " (tpl)"}
              </Badge>
            ))}
            {!p.blocks.length && <span className="text-muted-foreground">—</span>}
          </div>
        </div>
        <div className="space-y-1 rounded-lg border p-2">
          <div className="font-medium">Flows ({p.flows.length})</div>
          <div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto">
            {p.flows.map((f) => (
              <Badge key={f.id} variant="outline" className="text-[10px] font-normal">
                {f.name}
              </Badge>
            ))}
            {!p.flows.length && <span className="text-muted-foreground">—</span>}
          </div>
          {p.skills.length > 0 && <div className="pt-1 text-muted-foreground">+ {p.skills.length} skills</div>}
        </div>
      </div>

      <div className="space-y-2 rounded-lg border p-2 text-xs">
        <div className="flex items-center gap-1.5 font-medium">
          {p.risks.length ? <ShieldAlert className="size-3.5 text-amber-400" /> : <ShieldCheck className="size-3.5 text-emerald-400" />}
          {p.risks.length ? "What it runs" : "Runs no code of its own (blocks, flows and skills only)"}
        </div>
        {p.risks.length > 0 && (
          <ul className="max-h-40 space-y-1 overflow-y-auto">
            {p.risks.map((r, i) => (
              <li key={i} className="grid grid-cols-[150px_1fr] gap-2">
                <span className={cn(r.kind === "host-script" || r.kind === "shell" ? "text-amber-300" : "text-muted-foreground")}>
                  {RISK_LABEL[r.kind]} · {r.where}
                </span>
                <code className="truncate font-mono text-[10px]" title={r.detail}>
                  {r.detail}
                </code>
              </li>
            ))}
          </ul>
        )}
        {p.risks.length > 0 && (
          <p className="text-[11px] text-muted-foreground">
            Scripts, setup steps and executables run in a container. Its dependencies are installed into its own copy, so they can't clash with
            another pack's.
          </p>
        )}
        {p.needsHost && (
          <label className="flex items-center gap-2 pt-1">
            <Switch checked={trustHost} onCheckedChange={setTrustHost} />
            <span>
              Allow it to run code <b>on this machine</b> (its shell commands and "this machine" scripts won't work otherwise)
            </span>
          </label>
        )}
      </div>

      {(p.missing.length > 0 || p.conflicts.length > 0 || p.breaks.length > 0) && (
        <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-2 text-xs">
          <div className="font-medium">Other packs</div>
          {p.missing.map((r) => (
            <div key={r.id} className="flex items-center gap-2">
              <span className="flex-1">
                Needs <b>{r.id}</b> {r.version}, which isn't installed.
              </span>
              {r.source ? (
                <Button size="sm" variant="outline" className="h-7" onClick={() => onPreview({ url: r.source! })}>
                  Add {r.id} first
                </Button>
              ) : (
                <span className="text-muted-foreground">add it from the Add pack tab</span>
              )}
            </div>
          ))}
          {p.conflicts.map((c) => {
            const inst = installed.find((i) => i.id === c.id);
            return (
              <div key={c.id} className="flex items-center gap-2">
                <span className="flex-1">
                  Needs <b>{c.id}</b> {c.required}, but {c.installed} is installed.
                </span>
                {inst && inst.source.type !== "zip" && (
                  <Button size="sm" variant="outline" className="h-7" onClick={() => onPreview({ update: c.id })}>
                    Update {c.id}
                  </Button>
                )}
              </div>
            );
          })}
          {p.breaks.map((b) => (
            <div key={b.id} className="text-amber-300">
              The installed <b>{b.id}</b> pack needs {m.id} {b.requires} — this version ({m.version}) may break it.
            </div>
          ))}
          {blocked && (
            <label className="flex items-center gap-2 pt-1">
              <Switch checked={anyway} onCheckedChange={setAnyway} />
              Install anyway (blocks that need the missing pieces will show as broken)
            </label>
          )}
        </div>
      )}

      {p.problems.length > 0 && (
        <ul className="space-y-0.5 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-200">
          {p.problems.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      )}

      <ErrorNote text={error} />
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={busy || !!unchanged || (blocked && !anyway) || (!!differentSource && !replace)} onClick={() => void install()}>
          {busy ? <Loader2 className="animate-spin" /> : <Download />} {p.existing ? "Update" : "Install"}
        </Button>
      </div>
    </div>
  );
}

// ---------- add ----------

function AddPack({ onPreview, busy, error }: { onPreview: (from: PackFrom) => void; busy: boolean; error?: string }) {
  const [mode, setMode] = useState<"link" | "folder" | "zip">("link");
  const [url, setUrl] = useState("");
  const [folder, setFolder] = useState("");
  const [link, setLink] = useState(false);
  const [zip, setZip] = useState<File | null>(null);
  const [zipPath, setZipPath] = useState("");

  const option = (m: typeof mode, icon: React.ReactNode, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={mode === m}
      onClick={() => setMode(m)}
      className={cn(
        "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-sm [&_svg]:size-4",
        mode === m ? "bg-background shadow-xs" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon} {label}
    </button>
  );

  return (
    <div className="space-y-4">
      <div role="tablist" className="flex gap-0.5 rounded-lg bg-secondary/70 p-0.5">
        {option("link", <Link2 />, "GitHub / GitLab")}
        {option("folder", <FolderOpen />, "Folder")}
        {option("zip", <Upload />, "Zip")}
      </div>

      {mode === "link" && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim()) onPreview({ url: url.trim() });
          }}
        >
          <Label htmlFor="pack-url">Repository link</Label>
          <div className="flex gap-2">
            <Input id="pack-url" autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder={BASE_PACK_URL} className="font-mono text-xs" />
            <Button type="submit" disabled={busy || !url.trim()}>
              {busy ? <Loader2 className="animate-spin" /> : <GitBranch />} Preview
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            A repo, a branch or tag (<code>…/tree/v1.2.0</code>) or a folder inside one (<code>…/tree/main/packs/review</code>). Self-hosted GitLab works too.
            Without a branch it takes the latest release. Private repos use <code>GITHUB_TOKEN</code> / <code>GITLAB_TOKEN</code> from your Inputs.
          </p>
        </form>
      )}

      {mode === "folder" && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (folder.trim()) onPreview({ folder: folder.trim(), link });
          }}
        >
          <Label htmlFor="pack-folder">Folder on this machine (with manifest.json)</Label>
          <div className="flex gap-2">
            <Input id="pack-folder" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="C:\packs\my-pack" className="font-mono text-xs" />
            {desktop && (
              <Button type="button" variant="outline" onClick={async () => setFolder((await desktop!.pickFolder("Pick a pack folder")) ?? folder)}>
                Browse…
              </Button>
            )}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={link} onCheckedChange={setLink} />
            Link it instead of copying <span className="text-xs text-muted-foreground">(edits show up live — for building a pack)</span>
          </label>
          <div className="flex justify-end">
            <Button type="submit" disabled={busy || !folder.trim()}>
              {busy ? <Loader2 className="animate-spin" /> : <FolderOpen />} Preview
            </Button>
          </div>
        </form>
      )}

      {mode === "zip" && (
        <form
          className="space-y-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (zipPath) onPreview({ zipPath });
            else if (zip) onPreview({ zipName: zip.name, zipBase64: await readAsBase64(zip) });
          }}
        >
          <Label htmlFor="pack-zip">Zip of a pack</Label>
          <div className="flex gap-2">
            {desktop ? (
              <>
                <Input id="pack-zip" readOnly value={zipPath} placeholder="No file picked" className="font-mono text-xs" />
                <Button type="button" variant="outline" onClick={async () => setZipPath((await desktop!.pickFile("Pick a pack zip", ["zip"])) ?? zipPath)}>
                  Browse…
                </Button>
              </>
            ) : (
              <Input id="pack-zip" type="file" accept=".zip,application/zip" onChange={(e) => setZip(e.target.files?.[0] ?? null)} />
            )}
          </div>
          <div className="flex justify-end">
            <Button type="submit" disabled={busy || (!zip && !zipPath)}>
              {busy ? <Loader2 className="animate-spin" /> : <Upload />} Preview
            </Button>
          </div>
        </form>
      )}

      <ErrorNote text={error} />
    </div>
  );
}

// ---------- share ----------

/** Your own blocks and flows an export needs along with the ones you picked (templates, subflows). */
function closure(blockIds: Set<string>, flowIds: Set<string>, blocks: BlockDef[], flows: Flow[]) {
  const b = new Set(blockIds);
  const f = new Set(flowIds);
  let grew = true;
  while (grew) {
    grew = false;
    const add = (set: Set<string>, id: string | null | undefined) => {
      if (id && !id.includes("/") && !set.has(id)) {
        set.add(id);
        grew = true;
      }
    };
    for (const id of f) {
      for (const n of flows.find((x) => x.id === id)?.nodes ?? []) {
        add(b, n.data.blockId);
        add(f, n.data.overrides?.subflow?.flowId);
      }
    }
    for (const id of b) {
      const blk = blocks.find((x) => x.id === id);
      add(b, blk?.extends);
      add(f, blk?.config.subflow?.flowId);
    }
  }
  return { blocks: b, flows: f };
}

function Share() {
  const data = useStore((s) => s.data);
  const myBlocks = (data?.blocks ?? []).filter((b) => !b.pack);
  const myFlows = (data?.flows ?? []).filter((f) => !f.pack);
  const [pickedBlocks, setPickedBlocks] = useState<Set<string>>(new Set());
  const [pickedFlows, setPickedFlows] = useState<Set<string>>(new Set());
  const [id, setId] = useState("my-pack");
  const [name, setName] = useState("My pack");
  const [version, setVersion] = useState("1.0.0");
  const [description, setDescription] = useState("");
  const [author, setAuthor] = useState("");
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();

  const all = useMemo(() => closure(pickedBlocks, pickedFlows, myBlocks, myFlows), [pickedBlocks, pickedFlows, myBlocks, myFlows]);
  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setter(next);
  };
  const count = all.blocks.size + all.flows.size;

  const run = async (toFolder: boolean) => {
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    try {
      const r = await api.exportPack({
        manifest: { id, name, version, ...(description.trim() ? { description: description.trim() } : {}), ...(author.trim() ? { author: author.trim() } : {}) },
        blockIds: [...all.blocks],
        flowIds: [...all.flows],
        ...(toFolder ? { folder } : {}),
      });
      if (r.zipBase64 && r.fileName) {
        downloadBase64(r.fileName, r.zipBase64);
        setDone(`Downloaded ${r.fileName} (${r.fileCount} files).`);
      } else setDone(`Wrote ${r.fileCount} files to ${r.folder}.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const item = (key: string, label: string, sub: string | undefined, checked: boolean, implied: boolean, onClick: () => void) => (
    <label key={key} className={cn("flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-accent", implied && "text-muted-foreground")}>
      <input type="checkbox" checked={checked || implied} disabled={implied && !checked} onChange={onClick} className="accent-primary" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {implied && !checked ? <span className="text-[10px]">needed</span> : sub && <span className="text-[10px] text-muted-foreground">{sub}</span>}
    </label>
  );

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Pick your blocks and flows to share. Templates and subflows they use come along; blocks from other packs become dependencies. Publish the result as a
        GitHub/GitLab repo (start from{" "}
        <a href={BASE_PACK_URL} target="_blank" rel="noreferrer" className="underline">
          sandflow-base-boxes
        </a>{" "}
        → Use this template) and others add it with its link.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <div className="text-xs font-medium">Your flows</div>
          <div className="max-h-48 overflow-y-auto rounded-lg border p-1">
            {myFlows.map((f) => item(f.id, f.name, `${f.nodes.length} blocks`, pickedFlows.has(f.id), all.flows.has(f.id), () => toggle(pickedFlows, setPickedFlows, f.id)))}
            {!myFlows.length && <div className="p-2 text-xs text-muted-foreground">No flows of your own yet.</div>}
          </div>
        </div>
        <div className="space-y-1">
          <div className="text-xs font-medium">Your blocks and templates</div>
          <div className="max-h-48 overflow-y-auto rounded-lg border p-1">
            {myBlocks.map((b) => {
              let kind = "";
              try {
                kind = resolveBlock(b.id, data?.blocks ?? []).kind;
              } catch {
                /* broken */
              }
              return item(b.id, b.name, b.isTemplate ? "template" : kind, pickedBlocks.has(b.id), all.blocks.has(b.id), () => toggle(pickedBlocks, setPickedBlocks, b.id));
            })}
            {!myBlocks.length && <div className="p-2 text-xs text-muted-foreground">No blocks of your own yet.</div>}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="space-y-1">
          <Label htmlFor="exp-id">Pack id</Label>
          <Input id="exp-id" value={id} onChange={(e) => setId(e.target.value.toLowerCase())} aria-invalid={!PACK_ID_RE.test(id)} className="h-8 font-mono text-xs" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="exp-name">Name</Label>
          <Input id="exp-name" value={name} onChange={(e) => setName(e.target.value)} className="h-8" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="exp-version">Version</Label>
          <Input id="exp-version" value={version} onChange={(e) => setVersion(e.target.value)} className="h-8 font-mono text-xs" />
        </div>
      </div>
      <div className="grid grid-cols-[2fr_1fr] gap-3">
        <div className="space-y-1">
          <Label htmlFor="exp-desc">Description</Label>
          <Textarea id="exp-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="exp-author">Author</Label>
          <Input id="exp-author" value={author} onChange={(e) => setAuthor(e.target.value)} className="h-8" />
        </div>
      </div>

      <ErrorNote text={error} />
      {done && <div className="rounded border border-emerald-500/40 bg-emerald-500/10 p-2 text-xs text-emerald-300">{done}</div>}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="mr-auto text-xs text-muted-foreground">{count ? `${count} items` : "Nothing picked"}</span>
        <Input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="Empty folder to write to" className="h-8 w-56 font-mono text-xs" />
        {desktop && (
          <Button size="sm" variant="outline" onClick={async () => setFolder((await desktop!.pickFolder("Folder for the pack")) ?? folder)}>
            Browse…
          </Button>
        )}
        <Button size="sm" variant="outline" disabled={busy || !count || !folder.trim() || !PACK_ID_RE.test(id)} onClick={() => void run(true)}>
          <FolderOpen /> Save to folder
        </Button>
        <Button size="sm" disabled={busy || !count || !PACK_ID_RE.test(id)} onClick={() => void run(false)}>
          {busy ? <Loader2 className="animate-spin" /> : <Download />} Download zip
        </Button>
      </div>
    </div>
  );
}

// ---------- dialog ----------

export function PacksDialog() {
  const open = useStore((s) => s.packsOpen);
  const packs = useStore((s) => s.data?.packs ?? []);
  const setOpen = useStore((s) => s.setPacksOpen);
  const [tab, setTab] = useState<Tab>("installed");
  const [preview, setPreview] = useState<PackPreview | null>(null);
  /** Previews we stepped away from to add a dependency first — re-staged when that's done. */
  const [resume, setResume] = useState<PackFrom[]>([]);
  const [lastFrom, setLastFrom] = useState<PackFrom | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) {
      setPreview(null);
      setResume([]);
      setError(undefined);
    }
  }, [open]);

  const stage = async (from: PackFrom, pushCurrent = false) => {
    setBusy(true);
    setError(undefined);
    try {
      const p = await api.previewPack(from);
      if (pushCurrent && lastFrom) setResume((r) => [...r, lastFrom]);
      setLastFrom(from);
      setPreview(p);
    } catch (e) {
      setError((e as Error).message);
      if (!pushCurrent) setPreview(null);
    } finally {
      setBusy(false);
    }
  };

  const afterInstall = () => {
    const next = resume.at(-1);
    if (next) {
      setResume((r) => r.slice(0, -1));
      void stage(next);
    } else {
      setPreview(null);
      setTab("installed");
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 p-0 sm:max-w-3xl">
        <DialogHeader className="border-b p-4">
          <DialogTitle className="flex items-center gap-2">
            <Package className="size-5" /> Packs
          </DialogTitle>
          <DialogDescription>Blocks, templates and flows you can add from others — or share your own.</DialogDescription>
        </DialogHeader>
        <ScrollArea className="flex min-h-0 flex-1 flex-col" viewportClassName="min-h-0 flex-1">
          <div className="p-4">
          {preview ? (
            <>
              {resume.length > 0 && (
                <div className="mb-3 rounded border border-sky-500/40 bg-sky-500/10 p-2 text-xs text-sky-200">
                  Adding a pack the previous one needs. After this you'll be back to reviewing it.
                </div>
              )}
              <Review
                key={preview.token}
                preview={preview}
                onInstalled={afterInstall}
                onCancel={() => {
                  setPreview(null);
                  setResume([]);
                }}
                onPreview={(from) => void stage(from, true)}
              />
              <ErrorNote text={error} />
            </>
          ) : (
            <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="gap-4">
              <TabsList className="w-full">
                <TabsTrigger value="installed">Installed ({packs.length})</TabsTrigger>
                <TabsTrigger value="add">Add pack</TabsTrigger>
                <TabsTrigger value="share">Share my blocks</TabsTrigger>
              </TabsList>
              <TabsContent value="installed" className="space-y-3">
                {packs.map((p) => (
                  <PackCard key={p.id} pack={p} busy={busy} onUpdate={(id) => void stage({ update: id })} />
                ))}
                {!packs.length && <div className="py-6 text-center text-sm text-muted-foreground">No packs installed.</div>}
                <ErrorNote text={error} />
              </TabsContent>
              <TabsContent value="add">
                <AddPack onPreview={(from) => void stage(from)} busy={busy} error={error} />
              </TabsContent>
              <TabsContent value="share">
                <Share />
              </TabsContent>
            </Tabs>
          )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
