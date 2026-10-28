// Block editor sections for gates: a Checks block's commands, and an agent's verdict / docs-only skip / dev server.

import { Plus, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { BlockConfig, CheckCommand, ResolvedConfig } from "../../shared/types";

function Reset({ shown, onReset }: { shown: boolean; onReset: () => void }) {
  return shown ? (
    <button type="button" onClick={onReset} className="text-muted-foreground hover:text-foreground" title="Reset to inherited">
      <RotateCcw className="size-3" />
    </button>
  ) : (
    <span className="text-[10px] text-muted-foreground">inherited</span>
  );
}

/** The command list of a Checks block (replaced as a whole when edited). */
export function ChecksEditor({ own, cfg, onChange }: { own: BlockConfig["checks"]; cfg: ResolvedConfig["checks"]; onChange: (checks: BlockConfig["checks"]) => void }) {
  const commands = cfg.commands;
  const setCommands = (next: CheckCommand[]) => onChange({ ...own, commands: next });
  const update = (i: number, patch: Partial<CheckCommand>) => setCommands(commands.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Label className="text-xs">Checks (run in the run&apos;s worktree, in order)</Label>
        <Reset shown={own?.commands !== undefined} onReset={() => onChange(own?.reuse === undefined ? undefined : { reuse: own.reuse })} />
      </div>
      {commands.map((c, i) => (
        <div key={i} className="grid grid-cols-[8rem_1fr_6rem_auto_auto] items-center gap-2">
          <Input className="h-8 text-xs" value={c.name} placeholder="name" onChange={(e) => update(i, { name: e.target.value })} aria-label="Check name" />
          <Input className="h-8 font-mono text-xs" value={c.run} placeholder="npm test" onChange={(e) => update(i, { run: e.target.value })} aria-label="Command" />
          <Input
            className="h-8 text-xs"
            type="number"
            min={1}
            value={c.timeoutSeconds ?? ""}
            placeholder="600 s"
            title="Time limit (seconds)"
            onChange={(e) => update(i, { timeoutSeconds: e.target.value ? Math.max(1, Number(e.target.value)) : undefined })}
          />
          <label className="flex items-center gap-1.5 text-xs" title="A required check that fails makes the block leave through fail; an advisory one is only reported">
            <Switch checked={c.required !== false} onCheckedChange={(v) => update(i, { required: v ? undefined : false })} />
            required
          </label>
          <Button size="icon" variant="ghost" className="size-8" title="Remove" onClick={() => setCommands(commands.filter((_, j) => j !== i))}>
            <Trash2 />
          </Button>
        </div>
      ))}
      <Button size="sm" variant="outline" onClick={() => setCommands([...commands, { name: "", run: "" }])}>
        <Plus /> Add check
      </Button>
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={cfg.reuse} onCheckedChange={(v) => onChange({ ...own, reuse: v })} />
        Reuse the last results when nothing changed
        <Reset shown={own?.reuse !== undefined} onReset={() => onChange(own?.commands === undefined ? undefined : { commands: own.commands })} />
      </label>
      <p className="text-[11px] text-muted-foreground">
        The block leaves through <b>pass</b> when every required check passes, else <b>fail</b> — wire <b>fail</b> to a fix step: it gets the
        failing checks&apos; output as its steer. Commands run in the run&apos;s sandbox (on this machine with Sandbox: None).
      </p>
    </div>
  );
}

/** An agent block as a gate (verdict, skip on docs-only changes) and its dev server. */
export function AgentGateFields({ c, cfg, setCfg }: { c: BlockConfig; cfg: ResolvedConfig; setCfg: (patch: BlockConfig) => void }) {
  const setDev = (patch: Partial<NonNullable<BlockConfig["devServer"]>>) => {
    const next = { ...c.devServer, ...patch };
    for (const k of Object.keys(next) as (keyof typeof next)[]) if (next[k] === undefined || next[k] === "") delete next[k];
    setCfg({ devServer: Object.keys(next).length ? next : undefined });
  };
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={cfg.verdict} onCheckedChange={(v) => setCfg({ verdict: v })} />
        Gate: the agent answers PASS or FAIL
        <Reset shown={c.verdict !== undefined} onReset={() => setCfg({ verdict: undefined })} />
      </label>
      {cfg.verdict && (
        <>
          <p className="-mt-1 text-[11px] text-muted-foreground">
            The node leaves through <b>pass</b> or <b>fail</b> (with its artifact and steer). It must end with{" "}
            <code>&lt;verdict&gt;PASS&lt;/verdict&gt;</code> or <code>&lt;verdict&gt;FAIL&lt;/verdict&gt;</code>; it&apos;s asked once more when it
            doesn&apos;t, and no verdict counts as FAIL.
          </p>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={cfg.skipDocsOnly} onCheckedChange={(v) => setCfg({ skipDocsOnly: v })} />
            Pass without running when only docs changed
            <Reset shown={c.skipDocsOnly !== undefined} onReset={() => setCfg({ skipDocsOnly: undefined })} />
          </label>
        </>
      )}
      <div className="grid grid-cols-[2fr_2fr_1fr] gap-2">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Label className="text-xs">Dev server command</Label>
            <Reset shown={c.devServer?.command !== undefined} onReset={() => setDev({ command: undefined })} />
          </div>
          <Input className="font-mono text-xs" value={c.devServer?.command ?? ""} placeholder={cfg.devServer.command || "npm run dev (none)"} onChange={(e) => setDev({ command: e.target.value })} />
        </div>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Label className="text-xs">Ready URL</Label>
            <Reset shown={c.devServer?.readyUrl !== undefined} onReset={() => setDev({ readyUrl: undefined })} />
          </div>
          <Input className="font-mono text-xs" value={c.devServer?.readyUrl ?? ""} placeholder={cfg.devServer.readyUrl || "http://127.0.0.1:5173/"} onChange={(e) => setDev({ readyUrl: e.target.value })} />
        </div>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Label className="text-xs">Wait (s)</Label>
            <Reset shown={c.devServer?.startupTimeoutSeconds !== undefined} onReset={() => setDev({ startupTimeoutSeconds: undefined })} />
          </div>
          <Input
            type="number"
            min={1}
            className="text-xs"
            value={c.devServer?.startupTimeoutSeconds ?? ""}
            placeholder={String(cfg.devServer.startupTimeoutSeconds)}
            onChange={(e) => setDev({ startupTimeoutSeconds: e.target.value ? Math.max(1, Number(e.target.value)) : undefined })}
          />
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">
        A dev server starts in the worktree before the agent and stops after it; the agent is told it&apos;s running. Inside a container the URL is
        the container&apos;s own (<code>127.0.0.1</code> there).
      </p>
    </div>
  );
}
