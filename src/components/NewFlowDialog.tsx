import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useStore } from "@/lib/store";

const EMPTY = "__empty__";

export function NewFlowDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const flows = useStore((s) => s.data?.flows ?? []);
  const currentFlowId = useStore((s) => s.currentFlowId);
  const createFlow = useStore((s) => s.createFlow);
  const [from, setFrom] = useState(EMPTY);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);

  // Default to cloning the pipeline on screen; suggest a name until the user types one.
  useEffect(() => {
    if (!open) return;
    setFrom(currentFlowId ?? EMPTY);
    setNameTouched(false);
  }, [open, currentFlowId]);

  useEffect(() => {
    if (nameTouched) return;
    const src = flows.find((f) => f.id === from);
    setName(src ? `${src.name} (copy)` : `Flow ${flows.length + 1}`);
  }, [from, flows, nameTouched]);

  const source = flows.find((f) => f.id === from);
  const submit = () => {
    if (!name.trim()) return;
    createFlow(name.trim(), source?.id);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New pipeline</DialogTitle>
          <DialogDescription>Start empty or clone an existing pipeline — the copy is independent of the original.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="space-y-1.5">
            <Label>Start from</Label>
            <Select value={from} onValueChange={setFrom}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={EMPTY}>Empty pipeline</SelectItem>
                {flows.length > 0 && <SelectSeparator />}
                {flows.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    Clone “{f.name}” <span className="text-muted-foreground">({f.nodes.length} blocks)</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-flow-name">Name</Label>
            <Input
              id="new-flow-name"
              autoFocus
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
              aria-invalid={!name.trim()}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim()}>
              {source ? "Clone" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
