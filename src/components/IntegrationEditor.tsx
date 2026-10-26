// Block tab of an integration node: the harness action's options (as fields), whether the harness is installed and
// allowed to run here. A select option can load its choices by asking the harness (e.g. `meow workflows list`).

import { useEffect, useState } from "react";
import { Check, Loader2, Plug, RefreshCw, ShieldAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { actionOptions, choiceOf } from "../../shared/integrations";
import type { FlowNode, IntegrationChoice, IntegrationOption, IntegrationStatus, IntegrationValue, ResolvedConfig } from "../../shared/types";

/** Radix Select can't hold an empty value: this one means "not set on this node". */
const UNSET = "__unset";

function OptionField({
  option,
  value,
  inherited,
  loaded,
  onChange,
  onLoad,
  loading,
}: {
  option: IntegrationOption;
  /** Set on this node. */
  value: IntegrationValue | undefined;
  /** What it is without the node's value: the block's, else the option's default. */
  inherited: IntegrationValue | undefined;
  loaded?: IntegrationChoice[];
  onChange: (v: IntegrationValue | undefined) => void;
  onLoad: () => void;
  loading: boolean;
}) {
  const id = `int-opt-${option.id}`;
  const hint = option.description && <p className="text-[11px] text-muted-foreground">{option.description}</p>;
  if (option.type === "boolean") {
    const on = (value ?? inherited) === true;
    return (
      <div className="space-y-0.5">
        <label className="flex items-center justify-between gap-2 text-sm">
          {option.label}
          <Switch checked={on} onCheckedChange={(v) => onChange(v === (inherited === true) ? undefined : v)} />
        </label>
        {hint}
      </div>
    );
  }
  const placeholder = inherited !== undefined && inherited !== "" ? String(inherited) : option.placeholder;
  if (option.type === "select") {
    // Fixed choices first, in their order; what the harness listed adds the rest and its labels win.
    const byValue = new Map<string, IntegrationChoice>();
    for (const c of [...(option.choices ?? []).map(choiceOf), ...(loaded ?? [])]) byValue.set(c.value, { ...byValue.get(c.value), ...c });
    const choices = [...byValue.values()];
    const current = value === undefined ? undefined : String(value);
    if (current && !choices.some((c) => c.value === current)) choices.push({ value: current });
    const loader = option.choicesFrom && (
      <Button type="button" size="sm" variant="ghost" className="h-8 px-2" title="Ask the harness for the choices" disabled={loading} onClick={onLoad}>
        {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
      </Button>
    );
    return (
      <div className="space-y-1.5">
        <Label htmlFor={id}>{option.label}</Label>
        <div className="flex gap-1">
          {option.allowCustom ? (
            <>
              <Input
                id={id}
                list={`${id}-list`}
                className="h-8 flex-1"
                value={current ?? ""}
                placeholder={placeholder}
                onChange={(e) => onChange(e.target.value || undefined)}
              />
              <datalist id={`${id}-list`}>
                {choices.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label ?? c.value}
                  </option>
                ))}
              </datalist>
            </>
          ) : (
            <Select value={current ?? UNSET} onValueChange={(v) => onChange(v === UNSET ? undefined : v)}>
              <SelectTrigger id={id} size="sm" className="w-full flex-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNSET}>{placeholder ? `Default (${placeholder})` : "Not set"}</SelectItem>
                {choices.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label ? `${c.value} — ${c.label}` : c.value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {loader}
        </div>
        {hint}
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{option.label}</Label>
      {option.type === "text" ? (
        <Textarea id={id} rows={3} value={value === undefined ? "" : String(value)} placeholder={placeholder} onChange={(e) => onChange(e.target.value || undefined)} />
      ) : (
        <Input
          id={id}
          type={option.type === "number" ? "number" : "text"}
          className={option.type === "args" ? "h-8 font-mono text-xs" : "h-8"}
          value={value === undefined ? "" : String(value)}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value === "" ? undefined : option.type === "number" ? Number(e.target.value) : e.target.value)}
        />
      )}
      {hint}
      {option.type === "args" && <p className="text-[11px] text-muted-foreground">Passed as-is, split on spaces ("quote" to keep spaces) — nothing is expanded.</p>}
    </div>
  );
}

export function IntegrationEditor({ node, cfg }: { node: FlowNode; cfg: ResolvedConfig }) {
  const integrations = useStore((s) => s.data?.integrations ?? []);
  const { updateNodeOverrides, setIntegrationsOpen } = useStore.getState();
  const info = integrations.find((i) => i.id === cfg.integration.ref);
  const action = info?.def.actions.find((a) => a.id === cfg.integration.action);
  const [status, setStatus] = useState<IntegrationStatus>();
  const [loaded, setLoaded] = useState<Record<string, IntegrationChoice[]>>({});
  const [loading, setLoading] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    setStatus(undefined);
    if (!info?.trusted) return;
    let live = true;
    void api.integrationStatus(info.id).then(
      (s) => live && setStatus(s),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [info?.id, info?.trusted]);

  if (!info || !action) {
    return (
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-200">
        {info ? `"${info.def.name}" has no action "${cfg.integration.action}" any more.` : `Integration "${cfg.integration.ref}" isn't installed.`}{" "}
        <button type="button" className="underline" onClick={() => setIntegrationsOpen(true)}>
          Integrations
        </button>
      </div>
    );
  }

  const own = node.data.overrides?.integration?.options ?? {};
  // Without this node's values: the block's (cfg minus own), else each option's default.
  const blockValues = Object.fromEntries(Object.entries(cfg.integration.options).filter(([k]) => !(k in own)));
  const set = (id: string, v: IntegrationValue | undefined) => {
    const next = { ...own };
    if (v === undefined) delete next[id];
    else next[id] = v;
    updateNodeOverrides(node.id, { integration: Object.keys(next).length ? { options: next } : undefined });
  };
  const load = async (optionId: string) => {
    setLoading(optionId);
    setError(undefined);
    try {
      const choices = await api.integrationChoices(info.id, action.id, optionId);
      setLoaded((x) => ({ ...x, [optionId]: choices }));
      if (!choices.length) setError("The harness listed no choices");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(undefined);
    }
  };

  const options = actionOptions(info.def, action);
  return (
    <div className="space-y-3">
      <div className="space-y-1 rounded-lg border p-2 text-[11px] text-muted-foreground">
        <div className="flex items-center gap-1.5 text-xs text-foreground">
          <Plug className="size-3.5 shrink-0 text-sky-400" />
          <span className="flex-1">
            {info.def.name} · <code>{info.def.command} {action.args.join(" ")}</code>
          </span>
        </div>
        {!info.trusted ? (
          <div className="flex items-start gap-1.5 text-amber-300">
            <ShieldAlert className="size-3.5 shrink-0" />
            <span>
              The {info.pack} pack isn't allowed to run code on this machine yet —{" "}
              <button type="button" className="underline" onClick={() => setIntegrationsOpen(true)}>
                allow it in Integrations
              </button>
              .
            </span>
          </div>
        ) : status ? (
          <div className="flex items-center gap-1.5">
            {status.installed ? <Check className="size-3.5 text-emerald-400" /> : <X className="size-3.5 text-amber-400" />}
            {status.installed ? `Installed${status.version ? ` (${status.version})` : ""} — runs on this machine with your login` : status.error}
            {!status.installed && (
              <button type="button" className="underline" onClick={() => setIntegrationsOpen(true)}>
                How to install
              </button>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <Loader2 className="size-3.5 animate-spin" /> Checking it's installed…
          </div>
        )}
        {action.description && <p>{action.description}</p>}
      </div>
      {options.length > 0 && <div className="text-xs font-medium">Options (this node)</div>}
      {options.map((o) => (
        <OptionField
          key={o.id}
          option={o}
          value={own[o.id]}
          inherited={blockValues[o.id] ?? o.default}
          loaded={loaded[o.id]}
          loading={loading === o.id}
          onLoad={() => void load(o.id)}
          onChange={(v) => set(o.id, v)}
        />
      ))}
      {error && <div className="text-xs text-red-400">{error}</div>}
      {cfg.integration.exits.length > 0 && (
        <p className="text-[11px] text-muted-foreground">
          Leaves through {cfg.integration.exits.map((x) => `“${x}”`).join(", ")}, picked by the harness's exit code.
        </p>
      )}
    </div>
  );
}
