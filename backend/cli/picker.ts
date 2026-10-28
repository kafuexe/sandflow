// `sandflow -r`: an arrow-key list of runs on a raw-mode TTY (no deps). The state machine and rendering are pure
// functions; `pick` wires them to the terminal.

import path from "node:path";
import type { HistoryEntry } from "../history";

export interface PickerState {
  index: number;
  /** First visible row. */
  offset: number;
}

export type PickerKey = "up" | "down" | "pageup" | "pagedown" | "home" | "end" | "enter" | "cancel" | "other";

export function keyOf(data: string): PickerKey {
  switch (data) {
    case "\x1b[A":
    case "\x1bOA":
    case "k":
      return "up";
    case "\x1b[B":
    case "\x1bOB":
    case "j":
      return "down";
    case "\x1b[5~":
      return "pageup";
    case "\x1b[6~":
      return "pagedown";
    case "\x1b[H":
    case "\x1b[1~":
    case "g":
      return "home";
    case "\x1b[F":
    case "\x1b[4~":
    case "G":
      return "end";
    case "\r":
    case "\n":
      return "enter";
    case "\x1b":
    case "q":
    case "\x03": // Ctrl+C (raw mode delivers it as a key)
      return "cancel";
    default:
      return "other";
  }
}

export type PickerStep = { state: PickerState } | { pick: number } | { cancel: true };

export function step(s: PickerState, key: PickerKey, count: number, height: number): PickerStep {
  if (key === "cancel") return { cancel: true };
  if (key === "enter") return count ? { pick: s.index } : { cancel: true };
  const moves: Partial<Record<PickerKey, number>> = { up: -1, down: 1, pageup: -height, pagedown: height, home: -Infinity, end: Infinity };
  const d = moves[key];
  if (d === undefined || !count) return { state: s };
  const index = Math.max(0, Math.min(count - 1, s.index + d));
  let offset = s.offset;
  if (index < offset) offset = index;
  if (index >= offset + height) offset = index - height + 1;
  return { state: { index, offset } };
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const cut = (s: string, n: number) => (n <= 0 ? "" : s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`);
const pad = (s: string, n: number) => cut(s, n).padEnd(n);

/** One row: flow, status, age, repo, prompt snippet — fitted to `width`. */
export function pickerRow(e: HistoryEntry, now: number, width: number): string {
  const repo = e.repo ? path.basename(e.repo) : e.source === "desktop" ? "(desktop)" : "";
  const head = `${pad(e.flowName, 22)} ${pad(e.status, 9)} ${pad(ago(now - e.startedAt), 8)} ${pad(repo, 16)} `;
  const prompt = (e.prompt ?? "").replace(/\s+/g, " ").trim();
  return cut(head + prompt, width).trimEnd();
}

/** The picker's lines: a title, the visible rows (the selected one marked and inverted), a key hint. */
export function renderPicker(rows: string[], s: PickerState, height: number, width: number): string[] {
  const lines = ["Continue which run? (↑/↓, Enter; Esc or q cancels)"];
  for (let i = s.offset; i < Math.min(rows.length, s.offset + height); i++) {
    const text = cut(rows[i], width - 2);
    lines.push(i === s.index ? `\x1b[7m› ${text}\x1b[0m` : `  ${text}`);
  }
  if (rows.length > height) lines.push(`  (${s.index + 1}/${rows.length})`);
  return lines;
}

/** Ask on the terminal; resolves with the chosen entry, or undefined when cancelled. */
export function pick(
  entries: HistoryEntry[],
  io: { stdin: NodeJS.ReadableStream & { setRawMode?: (on: boolean) => unknown }; out: NodeJS.WriteStream },
): Promise<HistoryEntry | undefined> {
  const width = Math.max(40, io.out.columns ?? 100);
  const height = Math.max(3, Math.min(12, (io.out.rows ?? 24) - 4));
  const now = Date.now();
  const rows = entries.map((e) => pickerRow(e, now, width - 2));
  let state: PickerState = { index: 0, offset: 0 };
  let drawn = 0;
  const draw = () => {
    const lines = renderPicker(rows, state, height, width);
    io.out.write(`${drawn ? `\x1b[${drawn}A` : ""}\x1b[J${lines.join("\n")}\n`);
    drawn = lines.length;
  };
  return new Promise((resolve) => {
    io.stdin.setRawMode?.(true);
    io.stdin.resume();
    io.out.write("\x1b[?25l");
    draw();
    const finish = (v: HistoryEntry | undefined) => {
      io.stdin.removeListener("data", onData);
      io.stdin.setRawMode?.(false);
      io.stdin.pause();
      io.out.write(`\x1b[${drawn}A\x1b[J\x1b[?25h`);
      resolve(v);
    };
    const onData = (buf: Buffer) => {
      const r = step(state, keyOf(buf.toString("utf8")), rows.length, height);
      if ("cancel" in r) return finish(undefined);
      if ("pick" in r) return finish(entries[r.pick]);
      state = r.state;
      draw();
    };
    io.stdin.on("data", onData);
  });
}
