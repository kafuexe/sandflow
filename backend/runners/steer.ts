// Steering a working agent: the user sends it a message mid-run ("focus on X", "don't touch Y").
//
// How it reaches the agent:
//  - Agents whose sessions can be resumed (Claude Code, Codex, pi): the current turn is interrupted — the agent's
//    process tree is killed, on this computer or inside the container, without stopping the run — and the same
//    session is resumed with the message as the next user turn (`claude --resume <session>`). The agent keeps
//    everything it did and saw so far.
//  - Other agents, or before the agent's session id is known: the message waits for the agent's next turn (a
//    follow-up after a question, or one more turn right after the current one ends).

import type { SteerInbox } from "../engine";
import type { SteerRecord } from "../../shared/types";

/** Why a turn was aborted by steering (never the run's own Stop). */
export const STEERED = "steered";

/** The prompt that hands steering messages to the agent. */
export function steerPrompt(messages: string[], interrupted: boolean): string {
  const said = messages.length === 1 ? messages[0] : messages.map((m, i) => `${i + 1}. ${m}`).join("\n");
  return interrupted
    ? `The user sent a steering message while you were working (your work was paused to deliver it):\n\n${said}\n\n` +
        "Continue the task taking it into account, and follow the output protocol."
    : `The user sent a steering message while you were working:\n\n${said}\n\nTake it into account as you continue, and follow the output protocol.`;
}

interface AgentWithSessions {
  sessionStorage?: unknown;
  parseStreamLine?: (line: string) => { type: string; sessionId?: string }[];
  buildPrintCommand?: (o: Record<string, unknown>) => unknown;
}

/** Whether the agent provider can resume a session it started (sandcastle gives it `sessionStorage`). */
export const canResumeSessions = (agent: object) => {
  const a = agent as AgentWithSessions;
  return !!a.sessionStorage && typeof a.buildPrintCommand === "function";
};

/**
 * The agent, with every command it builds resuming `sessionId`. The session file is wherever the agent CLI left it
 * (the run's container lives as long as the run; on this computer it's the CLI's own folder), so this doesn't go
 * through sandcastle's resume, which needs the session captured to this computer first.
 */
export function resumingAgent<A extends object>(agent: A, sessionId: string): A {
  return new Proxy(agent, {
    get(target, key, receiver) {
      const v = Reflect.get(target, key, receiver);
      if (key !== "buildPrintCommand" || typeof v !== "function") return v;
      // A later follow-up may resume the session sandcastle captured since — that one wins.
      return (o: Record<string, unknown>) => v.call(target, { ...o, resumeSession: o?.resumeSession ?? sessionId });
    },
  });
}

/** Steering state of one agent node while it runs. */
export class Steering {
  /** The agent's current session, from its output stream. */
  session?: string;
  /** Iteration of the current turn's run, from the stream (sandcastle numbers them from 1 per run). */
  iteration = 0;
  /** Every message the agent got, in order — repeated in any fresh prompt (a new session wouldn't know them). */
  readonly applied: string[] = [];
  /** The node's agent, once it's made (messages sent before that wait for its first turn). */
  agent?: object;
  /** Kills the agent's command in flight (see `withAgentEnv`). */
  interrupt?: () => Promise<unknown>;
  private turn?: AbortController;
  private killing?: Promise<unknown>;
  private readonly inbox?: SteerInbox;

  constructor(
    private readonly o: {
      steerable?: (onSteer: () => void) => SteerInbox;
      log: (level: "info" | "warn", msg: string) => void;
    },
  ) {
    this.inbox = o.steerable?.(() => this.onSteer());
  }

  get resumable() {
    return !!this.agent && canResumeSessions(this.agent);
  }

  /** A raw line of the agent's output: picks up its session id. */
  seeLine(line: string, iteration?: number) {
    if (typeof iteration === "number") this.iteration = iteration;
    if (!line.startsWith("{")) return;
    let found: string | undefined;
    try {
      for (const ev of (this.agent as AgentWithSessions | undefined)?.parseStreamLine?.(line) ?? []) if (ev.type === "session_id" && ev.sessionId) found = ev.sessionId;
    } catch {
      return;
    }
    if (!found) return;
    const first = found !== this.session;
    this.session = found;
    // Messages that came in before the session was known can be delivered now.
    if (first && this.pending().length) this.onSteer();
  }

  pending(): SteerRecord[] {
    return this.inbox?.pending() ?? [];
  }

  /** Hands the pending messages to the agent: returns their text (marked applied), or [] when there are none. */
  take(how: "interrupt" | "next-turn"): string[] {
    const records = this.pending();
    if (!records.length) return [];
    this.inbox?.applied(records, how);
    const texts = records.map((r) => r.message);
    this.applied.push(...texts);
    return texts;
  }

  /** A turn of the agent starts: steering may abort `ctl` to interrupt it. */
  begin(ctl: AbortController) {
    this.turn = ctl;
    this.iteration = 0;
    this.killing = undefined;
  }

  end(ctl: AbortController) {
    if (this.turn === ctl) this.turn = undefined;
  }

  /** Whether this turn was stopped to deliver steering. */
  steered(ctl: AbortController) {
    return ctl.signal.aborted && ctl.signal.reason === STEERED;
  }

  /** Waits for the interrupted agent process to be gone (so two processes never write one session). */
  async settled() {
    await this.killing;
  }

  close(why?: string) {
    this.inbox?.close(why);
  }

  private onSteer() {
    const turn = this.turn;
    const records = this.pending();
    if (!records.length) return;
    if (!turn || turn.signal.aborted) return; // between turns: the next turn takes them
    if (!this.resumable) {
      this.inbox?.note(records, "This agent can't take messages mid-turn — it gets this when its current turn ends");
      this.o.log("info", "This agent can't resume its session mid-turn — the steering message is queued for its next turn");
      return;
    }
    if (!this.session) {
      this.inbox?.note(records, "Waiting for the agent's session to start");
      return;
    }
    this.o.log("info", "Interrupting the agent to deliver the steering message…");
    turn.abort(STEERED);
    this.killing = (this.interrupt?.() ?? Promise.resolve()).catch(() => {});
  }
}
