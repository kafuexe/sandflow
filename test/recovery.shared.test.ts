import { describe, expect, it } from "vitest";
import { CORE_BLOCKS, SUBFLOW_BLOCK } from "../shared/core";
import { exitText } from "../backend/proc";
import { BUILTIN_BLOCKS } from "../shared/library";
import {
  classifyFailure,
  isDeliveryStep,
  looksLikeACrash,
  parseDecision,
  recoverySettings,
  retryDelay,
  reviewPrompt,
  sameDecision,
} from "../shared/recovery";
import type { Flow } from "../shared/types";

const blocks = [...CORE_BLOCKS, ...BUILTIN_BLOCKS];
const errno = (code: string, message = code) => Object.assign(new Error(message), { code });

describe("classifyFailure (MEOW _looks_like_a_crash / _is_os_failure)", () => {
  it("crash-like exit codes: negative, raw NTSTATUS with the high bit set, signals", () => {
    expect(looksLikeACrash(-11)).toBe(true);
    expect(looksLikeACrash(0xc0000409)).toBe(true);
    expect(looksLikeACrash(0x80000000)).toBe(true);
    expect(looksLikeACrash(0x7fffffff)).toBe(false);
    expect(looksLikeACrash(1)).toBe(false);
    expect(looksLikeACrash(undefined)).toBe(false);
    expect(classifyFailure(Object.assign(new Error("boom"), { exitCode: -1073741819 }))).toBe("crash");
    expect(classifyFailure(new Error("claude exited with code 3221225477: "))).toBe("crash");
    expect(classifyFailure(new Error("Command exited with code -9"))).toBe("crash");
    expect(classifyFailure(Object.assign(new Error("Command failed"), { signal: "SIGSEGV" }))).toBe("crash");
    expect(classifyFailure(new Error("Process interrupted due to receipt of signal: SIGKILL"))).toBe("crash");
    // What the shell / script / integration runners report (backend/proc.ts exitText).
    expect(exitText({ code: 1, signal: "SIGSEGV" })).toBe("was killed by signal SIGSEGV");
    expect(classifyFailure(new Error(`Command ${exitText({ code: 1, signal: "SIGSEGV" })}`))).toBe("crash");
    expect(classifyFailure(new Error(`Script ${exitText({ code: 3221225477 })}`))).toBe("crash");
  });

  it("a chosen non-zero exit is the block failing", () => {
    expect(classifyFailure(new Error("Command exited with code 1: tests failed"))).toBe("error");
    expect(classifyFailure(new Error("Script exited with code 2"))).toBe("error");
    expect(classifyFailure(new Error("Manager returned nothing"))).toBe("error");
  });

  it("OS / network / CLI connection failures are transient; a missing CLI isn't", () => {
    expect(classifyFailure(errno("ECONNRESET", "read ECONNRESET"))).toBe("transient");
    expect(classifyFailure(errno("EBUSY", "resource busy or locked"))).toBe("transient");
    expect(classifyFailure(errno("EPERM", "operation not permitted, rename"))).toBe("transient");
    expect(classifyFailure(Object.assign(new Error("fetch failed"), { cause: errno("UND_ERR_SOCKET") }))).toBe("transient");
    expect(classifyFailure(new Error("claude exited with code 1: API Error: Connection error."))).toBe("transient");
    expect(classifyFailure(new Error("socket hang up"))).toBe("transient");
    expect(classifyFailure(errno("ENOENT", "spawn claude ENOENT"))).toBe("error");
  });

  it("a runner's own time limit is a timeout", () => {
    expect(classifyFailure(new Error("Command timed out after 1800s"))).toBe("timeout");
  });
});

describe("parseDecision (MEOW parse_decision)", () => {
  it("reads the decision from the whole answer, a fenced block, or the last object", () => {
    expect(parseDecision('{"action":"retry","reason":"flaky"}')).toEqual({ ok: true, decision: { action: "retry", reason: "flaky" } });
    expect(parseDecision('I looked.\n```json\n{"action":"resume","reason":"half done","notes":"run the tests"}\n```')).toEqual({
      ok: true,
      decision: { action: "resume", reason: "half done", notes: "run the tests" },
    });
    expect(parseDecision('Decision: {"action": "blocked", "reason": "needs a token"}')).toMatchObject({ ok: true, decision: { action: "blocked" } });
  });

  it("refuses what it doesn't trust, naming the problem", () => {
    expect(parseDecision("no idea")).toEqual({ ok: false, error: "its answer has no decision JSON" });
    expect(parseDecision("[1]")).toMatchObject({ ok: false, error: /JSON object/ });
    expect(parseDecision('{"action":"explode","reason":"x"}')).toMatchObject({ ok: false, error: /unknown action/ });
    expect(parseDecision('{"action":"retry"}')).toMatchObject({ ok: false, error: /reason/ });
    expect(parseDecision('{"action":"retry","reason":"x","why":"y"}')).toMatchObject({ ok: false, error: /unknown key\(s\): why/ });
    expect(parseDecision('{"action":"rescope","reason":"x"}')).toMatchObject({ ok: false, error: /rescope needs a task/ });
    expect(parseDecision('{"action":"retry","reason":"x","task":"t"}')).toMatchObject({ ok: false, error: /takes no task/ });
    expect(parseDecision('{"action":"retry","reason":"x","output":"o"}')).toMatchObject({ ok: false, error: /takes no output/ });
    expect(parseDecision('{"action":"retry","reason":"x","notes":3}')).toMatchObject({ ok: false, error: /notes must be a string/ });
  });

  it("skip keeps its output; rescope its task", () => {
    expect(parseDecision('{"action":"skip","reason":"optional","output":"nothing to lint"}')).toEqual({
      ok: true,
      decision: { action: "skip", reason: "optional", output: "nothing to lint" },
    });
    expect(parseDecision('{"action":"rescope","reason":"too big","task":"only the parser"}')).toMatchObject({ ok: true, decision: { task: "only the parser" } });
  });

  it("decisions are the same when action, notes and task are", () => {
    expect(sameDecision({ action: "resume", notes: "a" }, { action: "resume", notes: "a" })).toBe(true);
    expect(sameDecision({ action: "resume", notes: "a" }, { action: "resume", notes: "b" })).toBe(false);
    expect(sameDecision({ action: "retry" }, { action: "retry", notes: "" })).toBe(true);
  });
});

describe("recovery settings", () => {
  const n = (id: string, blockId: string) => ({ id, type: "block" as const, position: { x: 0, y: 0 }, data: { blockId } });
  it("defaults to triage when the flow has agent blocks (also inside a subflow), else off", () => {
    const shell: Flow = { id: "s", name: "S", nodes: [n("x", "shell")], edges: [] };
    const agent: Flow = { id: "a", name: "A", nodes: [n("p", "plan")], edges: [] };
    expect(recoverySettings(shell, [shell], blocks)).toEqual({ mode: "off", model: "", maxRecoveryCycles: 3, maxRetries: 2 });
    expect(recoverySettings(agent, [agent], blocks).mode).toBe("triage");
    const outer: Flow = { id: "o", name: "O", nodes: [{ ...n("sub", SUBFLOW_BLOCK), data: { blockId: SUBFLOW_BLOCK, overrides: { subflow: { flowId: "a" } } } }], edges: [] };
    expect(recoverySettings(outer, [outer, agent], blocks).mode).toBe("triage");
    expect(recoverySettings(outer, [outer, shell], blocks).mode).toBe("off");
    expect(recoverySettings({ ...agent, recovery: { mode: "off", maxRetries: 0, maxRecoveryCycles: 5, agent: { provider: "claudeCode", model: " haiku " } } }, [agent], blocks)).toEqual({
      mode: "off",
      model: "haiku",
      maxRecoveryCycles: 5,
      maxRetries: 0,
    });
  });

  it("backoff doubles from 1 s and is capped at 60 s", () => {
    expect([0, 1, 2, 3, 10].map(retryDelay)).toEqual([1000, 2000, 4000, 8000, 60000]);
  });

  it("delivery steps; the review prompt", () => {
    expect(isDeliveryStep({ kind: "auto", autoAction: "create-mr" })).toBe(true);
    expect(isDeliveryStep({ kind: "auto", autoAction: "post-comment" })).toBe(true);
    expect(isDeliveryStep({ kind: "auto", autoAction: "merge-parent" })).toBe(true);
    expect(isDeliveryStep({ kind: "auto", autoAction: "shell" })).toBe(false);
    expect(isDeliveryStep({ kind: "ai", autoAction: "create-mr" })).toBe(false);
    expect(reviewPrompt("crash", "exit -11")).toBe(
      "Your previous attempt crashed: exit -11. Check the work in the repo against your task, don't redo what's finished, then complete it.",
    );
  });
});
