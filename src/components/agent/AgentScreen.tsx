import { Loader2 } from "lucide-react";
import { useAgent } from "@/lib/agent";
import { Conversation } from "./Conversation";
import { NewRun } from "./NewRun";
import { RunList } from "./RunList";

/** Chat-style screen: every run on the left, the selected run (or a new one) on the right. */
export function AgentScreen() {
  const selectedId = useAgent((s) => s.selectedId);
  const run = useAgent((s) => (s.selectedId ? s.detail[s.selectedId] : undefined));
  const error = useAgent((s) => s.error);

  return (
    <div className="flex h-full min-h-0">
      <RunList />
      {!selectedId ? (
        <NewRun />
      ) : run ? (
        <Conversation key={run.id} run={run} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {error ? <span className="text-red-300">Couldn't open this run: {error}</span> : <Loader2 className="animate-spin" />}
        </div>
      )}
    </div>
  );
}
