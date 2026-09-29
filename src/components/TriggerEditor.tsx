import { useMemo } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { GIT_EVENTS } from "../../shared/events";
import { describeSchedule, INTERVAL_UNITS, upcoming, validateSchedule } from "../../shared/schedule";
import { validateTrigger } from "../../shared/validate";
import type { GitEventType, IntervalUnit, ScheduleSpec, TriggerConfig, TriggerType } from "../../shared/types";

const CRON_PRESETS: { label: string; expr: string }[] = [
  { label: "Every hour", expr: "0 * * * *" },
  { label: "Weekdays 09:00", expr: "0 9 * * 1-5" },
  { label: "Mondays 08:00", expr: "0 8 * * 1" },
  { label: "1st of month 09:00", expr: "0 9 1 * *" },
  { label: "Last Friday 17:00", expr: "0 17 * * 5L" },
  { label: "Every 30 s", expr: "*/30 * * * * *" },
];

let tzCache: string[] | undefined;
const timezones = () => (tzCache ??= (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? []);

/** `YYYY-MM-DDTHH:mm` for a datetime-local input. */
const localInput = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

function Seg<T extends string>({ value, options, onChange }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-md border p-0.5">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          onClick={() => onChange(o.v)}
          className={cn("rounded px-2.5 py-1 text-xs", value === o.v ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ScheduleFields({ spec, onChange }: { spec: ScheduleSpec | undefined; onChange: (s: ScheduleSpec) => void }) {
  const s: ScheduleSpec = spec ?? { kind: "interval", every: 1, unit: "hours" };
  const error = validateSchedule(s);
  const next = useMemo(() => (error ? [] : upcoming(s, new Date(), 3)), [s, error]);

  return (
    <div className="space-y-3">
      <Seg
        value={s.kind}
        options={[
          { v: "once", label: "Once" },
          { v: "interval", label: "Repeat" },
          { v: "cron", label: "Cron / advanced" },
        ]}
        onChange={(kind) =>
          onChange(
            kind === "once"
              ? { kind, at: localInput(new Date(Date.now() + 3600_000)) }
              : kind === "interval"
                ? { kind, every: 1, unit: "hours", start: localInput(new Date(new Date().setMinutes(0, 0, 0))) }
                : { kind, expr: "0 9 * * 1-5", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
          )
        }
      />
      {s.kind === "once" && (
        <div className="space-y-1.5">
          <Label className="text-xs">Date and time (local)</Label>
          <Input type="datetime-local" value={s.at} onChange={(e) => onChange({ ...s, at: e.target.value })} className="w-60" />
        </div>
      )}
      {s.kind === "interval" && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5">
            <Label className="text-xs">Every</Label>
            <Input
              type="number"
              min={1}
              value={s.every}
              onChange={(e) => onChange({ ...s, every: Math.max(1, Math.floor(Number(e.target.value) || 1)) })}
              className="w-20"
            />
          </div>
          <Select value={s.unit} onValueChange={(v) => onChange({ ...s, unit: v as IntervalUnit })}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {INTERVAL_UNITS.map((u) => (
                <SelectItem key={u} value={u}>
                  {u}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="space-y-1.5">
            <Label className="text-xs">Starting at (local)</Label>
            <Input type="datetime-local" value={s.start ?? ""} onChange={(e) => onChange({ ...s, start: e.target.value || undefined })} className="w-56" />
          </div>
        </div>
      )}
      {s.kind === "cron" && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1">
            {CRON_PRESETS.map((p) => (
              <button
                key={p.expr}
                type="button"
                onClick={() => onChange({ ...s, expr: p.expr })}
                className="rounded border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Input value={s.expr} onChange={(e) => onChange({ ...s, expr: e.target.value })} className="w-56 font-mono text-xs" placeholder="0 9 * * 1-5" />
            <Input
              list="sandflow-timezones"
              value={s.timezone ?? ""}
              onChange={(e) => onChange({ ...s, timezone: e.target.value || undefined })}
              className="w-56 text-xs"
              placeholder="Timezone (default: this machine)"
            />
            <datalist id="sandflow-timezones">
              {timezones().map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
          </div>
          <p className="text-[11px] text-muted-foreground">
            <code>min hour day month weekday</code>, optionally with a leading seconds field. Supports <code>*/15</code>, ranges,
            lists, <code>L</code> (last day / <code>5L</code> last Friday), <code>#</code> (<code>1#2</code> second Monday).
          </p>
        </div>
      )}
      {error ? (
        <div className="text-xs text-red-400">{error}</div>
      ) : (
        <div className="text-[11px] text-muted-foreground">
          {describeSchedule(s)} · next: {next.length ? next.map((d) => d.toLocaleString()).join(" · ") : "never (in the past)"}
        </div>
      )}
    </div>
  );
}

export function TriggerEditor({
  value,
  onChange,
  allowTypeChange = true,
}: {
  value: TriggerConfig;
  onChange: (t: TriggerConfig) => void;
  allowTypeChange?: boolean;
}) {
  const t = value;
  const set = (patch: Partial<TriggerConfig>) => onChange({ ...t, ...patch });
  const git = t.type === "github" || t.type === "gitlab";
  const mode = t.mode ?? "webhook";
  const problem = validateTrigger(t);

  return (
    <div className="space-y-4">
      {allowTypeChange && (
        <div className="space-y-1.5">
          <Label className="text-xs">Trigger type</Label>
          <Select value={t.type} onValueChange={(v) => set({ type: v as TriggerType })}>
            <SelectTrigger className="w-60">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="manual">Manual (Run button only)</SelectItem>
              <SelectItem value="schedule">Schedule</SelectItem>
              <SelectItem value="github">GitHub events</SelectItem>
              <SelectItem value="gitlab">GitLab events</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {t.type === "schedule" && <ScheduleFields spec={t.schedule} onChange={(schedule) => set({ schedule })} />}

      {git && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Repository</Label>
              <Input
                value={t.repo ?? ""}
                placeholder={t.type === "github" ? "owner/repo" : "group/subgroup/project"}
                onChange={(e) => set({ repo: e.target.value || undefined })}
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Host (self-hosted)</Label>
              <Input
                value={t.host ?? ""}
                placeholder={t.type === "github" ? "github.com" : "gitlab.com"}
                onChange={(e) => set({ host: e.target.value || undefined })}
                className="font-mono text-xs"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Events</Label>
            <div className="grid grid-cols-2 gap-1.5">
              {GIT_EVENTS.map((ev) => {
                const on = (t.events ?? []).includes(ev.type);
                return (
                  <label key={ev.type} className="flex items-center gap-2 text-xs">
                    <Switch
                      checked={on}
                      className="scale-75"
                      onCheckedChange={(v) =>
                        set({ events: v ? [...(t.events ?? []), ev.type] : (t.events ?? []).filter((x: GitEventType) => x !== ev.type) })
                      }
                    />
                    {ev.label}
                  </label>
                );
              })}
            </div>
            {!(t.events ?? []).length && <p className="text-[11px] text-muted-foreground">None selected = every supported event.</p>}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Receive events by</Label>
              <Seg
                value={mode}
                options={[
                  { v: "webhook", label: "Webhook" },
                  { v: "poll", label: "Polling" },
                ]}
                onChange={(m) => set({ mode: m })}
              />
            </div>
            {mode === "webhook" ? (
              <div className="space-y-1.5">
                <Label className="text-xs">Secret env var</Label>
                <Input
                  value={t.secretEnv ?? ""}
                  placeholder={t.type === "github" ? "GITHUB_WEBHOOK_SECRET" : "GITLAB_WEBHOOK_SECRET"}
                  onChange={(e) => set({ secretEnv: e.target.value.toUpperCase() || undefined })}
                  className="w-56 font-mono text-xs"
                />
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label className="text-xs">Poll every (s)</Label>
                <Input
                  type="number"
                  min={15}
                  value={t.pollSeconds ?? 60}
                  onChange={(e) => set({ pollSeconds: Math.max(15, Math.floor(Number(e.target.value) || 60)) })}
                  className="w-24"
                />
              </div>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {mode === "webhook"
              ? `Needs Settings → Webhooks enabled and the ${t.type === "github" ? "GitHub" : "GitLab"} host able to reach it. Use the secret's value as the webhook secret${t.type === "gitlab" ? " token" : ""}.`
              : `Uses ${t.type === "github" ? "gh" : "glab"} (must be logged in on this machine). Works behind NAT; only events after the first poll fire.`}
          </p>
        </div>
      )}

      {t.type !== "manual" && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">If the flow is still running:</span>
          <Seg
            value={t.overlap ?? "queue"}
            options={[
              { v: "queue", label: "Queue" },
              { v: "skip", label: "Skip" },
            ]}
            onChange={(overlap) => set({ overlap })}
          />
        </div>
      )}
      {problem && <div className="text-xs text-red-400">{problem}</div>}
    </div>
  );
}
