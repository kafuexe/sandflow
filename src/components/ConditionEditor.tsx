import { CaseSensitive, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { CONDITION_FIELDS, CONDITION_OPS, validateCondition } from "../../shared/conditions";
import type { ConditionOp, ConditionRule, ConditionSpec } from "../../shared/types";

export function ConditionEditor({ value, onChange }: { value: ConditionSpec; onChange: (c: ConditionSpec) => void }) {
  const c = value;
  const setRule = (i: number, patch: Partial<ConditionRule>) =>
    onChange({ ...c, rules: c.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const problem = validateCondition(c);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs">
        Continue out of <span className="font-medium text-emerald-400">true</span> when
        <Select value={c.match} onValueChange={(v) => onChange({ ...c, match: v as ConditionSpec["match"] })}>
          <SelectTrigger size="sm" className="h-7 w-24">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">ALL</SelectItem>
            <SelectItem value="any">ANY</SelectItem>
          </SelectContent>
        </Select>
        rules match, otherwise <span className="font-medium text-red-400">false</span>.
      </div>
      <datalist id="sandflow-condition-fields">
        {CONDITION_FIELDS.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
      {c.rules.map((r, i) => {
        const op = CONDITION_OPS.find((o) => o.op === r.op);
        return (
          <div key={i} className="flex items-center gap-1.5">
            <Input
              list="sandflow-condition-fields"
              value={r.field}
              placeholder="trigger.author"
              onChange={(e) => setRule(i, { field: e.target.value })}
              className="h-8 w-40 font-mono text-xs"
            />
            <Select value={r.op} onValueChange={(v) => setRule(i, { op: v as ConditionOp })}>
              <SelectTrigger size="sm" className="h-8 w-36 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONDITION_OPS.map((o) => (
                  <SelectItem key={o.op} value={o.op}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {op?.needsValue ? (
              <Input
                value={r.value ?? ""}
                placeholder={r.op === "in" ? "a, b, c" : r.op === "matches" ? "regex" : "value"}
                onChange={(e) => setRule(i, { value: e.target.value })}
                className="h-8 min-w-0 flex-1 text-xs"
              />
            ) : (
              <div className="flex-1" />
            )}
            <button
              type="button"
              title={r.caseSensitive ? "Case-sensitive" : "Case-insensitive"}
              onClick={() => setRule(i, { caseSensitive: !r.caseSensitive || undefined })}
              className={cn("rounded p-1", r.caseSensitive ? "bg-accent text-foreground" : "text-muted-foreground")}
            >
              <CaseSensitive className="size-4" />
            </button>
            <Button size="icon" variant="ghost" className="size-7" onClick={() => onChange({ ...c, rules: c.rules.filter((_, j) => j !== i) })}>
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        );
      })}
      <Button size="sm" variant="outline" onClick={() => onChange({ ...c, rules: [...c.rules, { field: "trigger.body", op: "contains", value: "" }] })}>
        <Plus /> Rule
      </Button>
      <p className="text-[11px] text-muted-foreground">
        Fields: <code>trigger.author</code>, <code>trigger.body</code>, <code>trigger.type</code>, <code>trigger.labels</code>,{" "}
        <code>trigger.raw.…</code> (full payload), <code>text</code> (input artifact), <code>json.…</code> (artifact parsed as
        JSON). No rules = always false.
      </p>
      {problem && <div className="text-xs text-red-400">{problem}</div>}
    </div>
  );
}
