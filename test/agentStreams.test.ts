// The Agent screen's run list must not open one live stream per unfinished run: each holds one of the browser's ~6
// connections per host, and with a few runs going every other request (e.g. loading an assistant edit) stalled.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunState, RunSummary } from "../shared/types";

const open = new Set<string>();
class FakeEventSource {
  constructor(public url: string) {
    open.add(url);
  }
  addEventListener() {}
  close() {
    open.delete(this.url);
  }
}

afterEach(() => {
  open.clear();
  vi.unstubAllGlobals();
});

const summary = (id: string): RunSummary => ({ id, flowId: "f", flowName: "F", status: "running", startedAt: 1 }) as RunSummary;

describe("agent run streams", () => {
  it("follows only the selected run live", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", async (url: string) => {
      const id = decodeURIComponent(url.split("/").pop()!);
      const run: Partial<RunState> = { id, flowId: "f", flowName: "F", status: "running", startedAt: 1, nodes: {}, logs: [] };
      return new Response(JSON.stringify(run), { status: 200 });
    });
    vi.resetModules();
    const { useAgent } = await import("../src/lib/agent");
    const a = () => useAgent.getState();
    a().ingest(["r1", "r2", "r3", "r4", "r5"].map(summary));
    expect(open.size).toBe(0);
    a().select("r2");
    await vi.waitFor(() => expect([...open]).toEqual(["/api/runs/r2/events"]));
    a().select("r4");
    await vi.waitFor(() => expect([...open]).toEqual(["/api/runs/r4/events"]));
    a().ingest(["r1", "r2", "r3", "r4", "r5"].map(summary));
    expect([...open]).toEqual(["/api/runs/r4/events"]);
  });
});
