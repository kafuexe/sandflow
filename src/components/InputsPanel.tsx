import { useMemo, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Plus, Trash2, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { useCurrentFlow, useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { ENV_NAME_RE, flowRequirements, isSecretName } from "../../shared/resolve";
import { missingInputs } from "../../shared/validate";

/** Inputs still missing for the current flow (drives the Run button). */
export function useMissingInputs(): string[] {
  const flow = useCurrentFlow();
  const data = useStore((s) => s.data);
  return useMemo(
    () => (flow && data ? missingInputs(flow, data.blocks, data.env, data.settings.startingPrompt) : []),
    [flow, data],
  );
}

function NodeChips({ nodes }: { nodes: { id: string; label: string }[] }) {
  const selectNode = useStore((s) => s.selectNode);
  return (
    <div className="flex flex-wrap gap-1">
      {nodes.map((n) => (
        <button key={n.id} type="button" onClick={() => selectNode(n.id)}>
          <Badge variant="outline" className="text-[10px] font-normal hover:bg-accent">
            {n.label}
          </Badge>
        </button>
      ))}
    </div>
  );
}

export function InputsPanel() {
  const flow = useCurrentFlow();
  const data = useStore((s) => s.data);
  const { setEnv, removeEnv, updateSettings } = useStore.getState();
  const missing = useMissingInputs();
  const [showOther, setShowOther] = useState(false);
  const [newName, setNewName] = useState("");

  const req = useMemo(() => (flow && data ? flowRequirements(flow, data.blocks) : undefined), [flow, data]);
  if (!flow || !data || !req) return null;

  const used = new Set(req.env.map((e) => e.name));
  const other = Object.keys(data.env)
    .filter((k) => !used.has(k))
    .sort();
  const promptMissing = req.startingPromptNodes.length > 0 && !data.settings.startingPrompt.trim();
  const newNameValid = ENV_NAME_RE.test(newName);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-5 p-3">
          {req.startingPromptNodes.length > 0 && (
            <section className="space-y-2">
              <Label htmlFor="starting-prompt">Starting prompt</Label>
              <Textarea
                id="starting-prompt"
                rows={5}
                value={data.settings.startingPrompt}
                onChange={(e) => updateSettings({ startingPrompt: e.target.value })}
                placeholder="Describe the task for this run…"
                aria-invalid={promptMissing}
                className="max-h-60"
              />
              <div className="text-[11px] text-muted-foreground">Used by:</div>
              <NodeChips nodes={req.startingPromptNodes} />
            </section>
          )}

          <section className="space-y-3">
            <div className="text-sm font-medium">Environment variables</div>
            {req.env.length === 0 && <div className="text-xs text-muted-foreground">No block in this flow needs env vars.</div>}
            {req.env.map((e) => {
              const value = data.env[e.name] ?? "";
              return (
                <div key={e.name} className="space-y-1.5">
                  <Label htmlFor={`env-${e.name}`} className="font-mono text-xs">
                    {e.name}
                  </Label>
                  <Input
                    id={`env-${e.name}`}
                    type={isSecretName(e.name) ? "password" : "text"}
                    value={value}
                    autoComplete="off"
                    onChange={(ev) => setEnv(e.name, ev.target.value)}
                    aria-invalid={!value.trim()}
                    className="h-8 font-mono text-xs"
                  />
                  <NodeChips nodes={e.nodes} />
                </div>
              );
            })}
          </section>

          <section className="space-y-2">
            <button
              type="button"
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setShowOther((v) => !v)}
            >
              {showOther ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              Other global env vars ({other.length})
            </button>
            {showOther && (
              <div className="space-y-2">
                {other.map((name) => (
                  <div key={name} className="flex items-center gap-1.5">
                    <span className="w-32 shrink-0 truncate font-mono text-[11px]" title={name}>
                      {name}
                    </span>
                    <Input
                      type={isSecretName(name) ? "password" : "text"}
                      value={data.env[name]}
                      autoComplete="off"
                      onChange={(ev) => setEnv(name, ev.target.value)}
                      className="h-7 font-mono text-xs"
                    />
                    <Button size="icon" variant="ghost" className="size-7" onClick={() => removeEnv(name)} title="Remove">
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                ))}
                <form
                  className="flex gap-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!newNameValid || newName in data.env) return;
                    setEnv(newName, "");
                    setNewName("");
                  }}
                >
                  <Input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value.toUpperCase())}
                    placeholder="NEW_VAR"
                    className="h-7 font-mono text-xs"
                    aria-invalid={newName !== "" && !newNameValid}
                  />
                  <Button size="sm" variant="outline" className="h-7" disabled={!newNameValid || newName in data.env}>
                    <Plus /> Add
                  </Button>
                </form>
              </div>
            )}
          </section>
        </div>
      </ScrollArea>
      <div
        className={cn(
          "flex items-center gap-2 border-t px-3 py-2 text-xs",
          missing.length ? "text-amber-400" : "text-emerald-400",
        )}
        title={missing.join(", ")}
      >
        {missing.length ? (
          <>
            <TriangleAlert className="size-4" /> {missing.length} missing: {missing.join(", ")}
          </>
        ) : (
          <>
            <CheckCircle2 className="size-4" /> All inputs ready
          </>
        )}
      </div>
    </div>
  );
}
