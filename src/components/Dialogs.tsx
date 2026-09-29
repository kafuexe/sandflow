import { useEffect, useState } from "react";
import { HelpCircle } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useCurrentFlow, useStore } from "@/lib/store";
import { nodeLabel } from "../../shared/resolve";
import type { SandboxKind } from "../../shared/types";
import { AnswerBox } from "./RunPanel";
import { SandboxImageSettings, UpdateSettingsField, WebhookSettingsField } from "./SandboxSettings";

export function SettingsDialog() {
  const open = useStore((s) => s.settingsOpen);
  const settings = useStore((s) => s.data?.settings);
  const { setSettingsOpen, updateSettings } = useStore.getState();
  if (!settings) return null;
  return (
    <Dialog open={open} onOpenChange={setSettingsOpen}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Global for every flow. Saved automatically.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Sandbox</Label>
            <Select value={settings.sandbox} onValueChange={(v) => updateSettings({ sandbox: v as SandboxKind })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="docker">Docker</SelectItem>
                <SelectItem value="podman">Podman</SelectItem>
                <SelectItem value="none">None (agents run directly on this machine)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {settings.sandbox !== "none" && <SandboxImageSettings settings={settings} />}
          <div className="space-y-1.5">
            <Label>Max steps per run (loop safety valve)</Label>
            <Input
              type="number"
              min={1}
              max={1000}
              value={settings.maxSteps}
              onChange={(e) => updateSettings({ maxSteps: Math.max(1, Number(e.target.value) || 1) })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Starting prompt</Label>
            <Textarea
              rows={5}
              value={settings.startingPrompt}
              onChange={(e) => updateSettings({ startingPrompt: e.target.value })}
            />
          </div>
          <WebhookSettingsField settings={settings} />
          <UpdateSettingsField settings={settings} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Pops up automatically when the run is waiting on a question. */
export function QuestionDialog() {
  const pending = useStore((s) => s.run?.pendingQuestion);
  const blocks = useStore((s) => s.data?.blocks ?? []);
  const flow = useCurrentFlow();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const key = pending ? `${pending.nodeId}:${pending.question}` : null;

  useEffect(() => {
    if (!key) setDismissed(null);
  }, [key]);

  if (!pending || dismissed === key) return null;
  const node = flow?.nodes.find((n) => n.id === pending.nodeId);
  return (
    <Dialog open onOpenChange={(o) => !o && setDismissed(key)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HelpCircle className="size-5 text-amber-400" /> {node ? nodeLabel(node, blocks) : "An agent"} has a question
          </DialogTitle>
          <DialogDescription>The flow is paused until you answer.</DialogDescription>
        </DialogHeader>
        <div className="max-h-64 overflow-auto rounded bg-muted p-3 text-sm whitespace-pre-wrap">{pending.question}</div>
        <AnswerBox autoFocus />
      </DialogContent>
    </Dialog>
  );
}
