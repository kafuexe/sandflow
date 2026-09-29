import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, FolderOpen, Loader2, PackageOpen, RefreshCw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { desktop } from "@/lib/desktop";
import { useStore } from "@/lib/store";
import { AGENT_TOOLS_MOUNT, DEFAULT_SANDBOX_IMAGE } from "../../shared/settings";
import type { Settings, UpdateSettings } from "../../shared/types";

type Status = Awaited<ReturnType<typeof api.sandboxStatus>>;

/** Container image + agent tools (air-gapped setup). Shown for Docker/Podman. */
export function SandboxImageSettings({ settings }: { settings: Settings }) {
  const updateSettings = useStore((s) => s.updateSettings);
  const saveStatus = useStore((s) => s.saveStatus);
  const [status, setStatus] = useState<Status | "loading">();
  const [bundle, setBundle] = useState("");
  const [importing, setImporting] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();

  const refresh = useCallback(() => {
    setStatus("loading");
    api.sandboxStatus().then(setStatus, (e: Error) => setMsg({ ok: false, text: e.message }));
  }, []);

  // Re-check once the chosen runtime / image name has been saved.
  useEffect(() => {
    if (saveStatus === "saved") refresh();
  }, [refresh, saveStatus, settings.sandbox, settings.sandboxImage]);

  const doImport = async () => {
    setImporting(true);
    setMsg(undefined);
    try {
      const { output } = await api.importSandbox(bundle.trim());
      setMsg({ ok: true, text: output || "Imported." });
      refresh();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setImporting(false);
    }
  };

  const st = status === "loading" ? undefined : status;
  return (
    <div className="space-y-4 rounded-lg border p-3">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label>Sandbox image</Label>
          <button type="button" onClick={refresh} className="text-muted-foreground hover:text-foreground" title="Re-check">
            <RefreshCw className="size-3.5" />
          </button>
        </div>
        <Input
          className="font-mono text-xs"
          value={settings.sandboxImage ?? ""}
          placeholder={DEFAULT_SANDBOX_IMAGE}
          onChange={(e) => updateSettings({ sandboxImage: e.target.value || undefined })}
        />
        <div className="flex items-center gap-1.5 text-xs">
          {status === "loading" && <Loader2 className="size-3.5 animate-spin" />}
          {st && !st.runtimeAvailable && (
            <span className="flex items-center gap-1 text-red-400">
              <XCircle className="size-3.5" /> {st.runtime} isn't available — install/start it first
            </span>
          )}
          {st?.runtimeAvailable && st.imagePresent && (
            <span className="flex items-center gap-1 text-emerald-400">
              <CheckCircle2 className="size-3.5" /> {st.image} is loaded in {st.runtime}
            </span>
          )}
          {st?.runtimeAvailable && !st.imagePresent && (
            <span className="flex items-center gap-1 text-amber-400">
              <XCircle className="size-3.5" /> {st.image} is not loaded — import the offline bundle below
            </span>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>Import offline bundle</Label>
        <div className="flex gap-2">
          <Input
            className="font-mono text-xs"
            value={bundle}
            placeholder="…/sandflow-sandbox-image-x.y.z-linux-amd64.tar.gz"
            onChange={(e) => setBundle(e.target.value)}
          />
          {desktop && (
            <Button
              size="icon"
              variant="outline"
              title="Browse"
              onClick={async () => {
                const p = await desktop!.pickFile("Sandflow sandbox image bundle", ["gz", "tar"]);
                if (p) setBundle(p);
              }}
            >
              <FolderOpen />
            </Button>
          )}
          <Button variant="outline" disabled={!bundle.trim() || importing} onClick={() => void doImport()}>
            {importing ? <Loader2 className="animate-spin" /> : <PackageOpen />} Import
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Download <code>sandflow-sandbox-image-…-linux-&lt;arch&gt;.tar.gz</code> from the release on a connected machine and
          copy it over. Runs <code>{st?.runtime ?? "docker"} load</code>; nothing is pulled from the internet.
        </p>
        {msg && <div className={`text-xs whitespace-pre-wrap ${msg.ok ? "text-emerald-400" : "text-red-400"}`}>{msg.text}</div>}
      </div>

      <div className="space-y-1.5">
        <Label>Agent tools folder</Label>
        <div className="flex gap-2">
          <Input
            className="font-mono text-xs"
            value={settings.agentToolsDir ?? ""}
            placeholder="Folder containing the Linux `claude` binary"
            onChange={(e) => updateSettings({ agentToolsDir: e.target.value || undefined })}
          />
          {desktop && (
            <Button
              size="icon"
              variant="outline"
              title="Browse"
              onClick={async () => {
                const p = await desktop!.pickFolder("Agent tools folder");
                if (p) updateSettings({ agentToolsDir: p });
              }}
            >
              <FolderOpen />
            </Button>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground">
          The image ships without an agent CLI. This folder is mounted read-only at <code>{AGENT_TOOLS_MOUNT}</code> (on PATH), so
          put the <strong>Linux</strong> build of <code>claude</code> (or another agent CLI) in it.
        </p>
      </div>
    </div>
  );
}

/** Listener for GitHub/GitLab webhooks (separate port, only /hooks/*). */
export function WebhookSettingsField({ settings }: { settings: Settings }) {
  const updateSettings = useStore((s) => s.updateSettings);
  const info = useStore((s) => s.triggers?.webhooks);
  const w = settings.webhooks ?? { enabled: false, host: "127.0.0.1", port: 8787 };
  const set = (patch: Partial<typeof w>) => updateSettings({ webhooks: { ...w, ...patch } });
  return (
    <div className="space-y-2 rounded-lg border p-3">
      <label className="flex items-center justify-between text-sm">
        <span>Webhook listener (GitHub / GitLab triggers)</span>
        <Switch checked={w.enabled} onCheckedChange={(v) => set({ enabled: v })} />
      </label>
      {w.enabled && (
        <>
          <div className="flex flex-wrap gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Listen on</Label>
              <Select value={w.host === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1"} onValueChange={(host) => set({ host })}>
                <SelectTrigger className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="127.0.0.1">This machine only (behind a proxy / tunnel)</SelectItem>
                  <SelectItem value="0.0.0.0">All network interfaces</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Port</Label>
              <Input
                type="number"
                min={1}
                max={65535}
                value={w.port}
                onChange={(e) => set({ port: Math.min(65535, Math.max(1, Math.floor(Number(e.target.value) || 8787))) })}
                className="w-24"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Public URL (how GitHub / GitLab reach this listener)</Label>
            <Input
              className="font-mono text-xs"
              value={w.publicUrl ?? ""}
              placeholder={`http://sandflow.corp.local:${w.port}`}
              onChange={(e) => set({ publicUrl: e.target.value || undefined })}
            />
          </div>
          <div className="text-[11px]">
            {info?.listening ? (
              <span className="text-emerald-400">● Listening on port {info.port}</span>
            ) : info?.error ? (
              <span className="text-red-400">{info.error}</span>
            ) : (
              <span className="text-muted-foreground">Starting…</span>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">
            Only <code>POST /hooks/…</code> is served on this port — the app and your secrets are never exposed. Every request is
            verified with the trigger's secret. Copy each trigger's webhook URL from its Block tab.
          </p>
        </>
      )}
    </div>
  );
}

export function UpdateSettingsField({ settings }: { settings: Settings }) {
  const updateSettings = useStore((s) => s.updateSettings);
  const updates: UpdateSettings = settings.updates ?? { mode: "github" };
  const [url, setUrl] = useState(updates.url ?? "");
  if (!desktop) return null;
  const setMode = (mode: UpdateSettings["mode"]) =>
    updateSettings({ updates: mode === "url" ? { mode, url: url || "https://" } : { mode } });
  return (
    <div className="space-y-1.5">
      <Label>App updates</Label>
      <Select value={updates.mode} onValueChange={(v) => setMode(v as UpdateSettings["mode"])}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="github">GitHub releases</SelectItem>
          <SelectItem value="url">Internal server (air-gapped)</SelectItem>
          <SelectItem value="off">Off</SelectItem>
        </SelectContent>
      </Select>
      {updates.mode === "url" && (
        <Input
          className="font-mono text-xs"
          value={url}
          placeholder="https://files.internal/sandflow/"
          onChange={(e) => {
            setUrl(e.target.value);
            if (/^https?:\/\/\S+$/i.test(e.target.value)) updateSettings({ updates: { mode: "url", url: e.target.value } });
          }}
        />
      )}
      <p className="text-[11px] text-muted-foreground">
        {updates.mode === "url"
          ? "Host the release files (latest.yml / latest-mac.yml / latest-linux.yml + installers) at this URL."
          : "Checked when the app starts."}{" "}
        Applies after restarting Sandflow.
      </p>
    </div>
  );
}
