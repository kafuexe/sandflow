---
name: schedule
description: Use when a Sandflow run should start at a future time, to list, reschedule or cancel scheduled Sandflow runs, or to set up the hourly checker that continues paused Sandflow runs unattended.
---

# schedule

When the user wants a run at a future time, **register it now** with the `sandflow` CLI; do not start the run, sleep,
or poll in this session, and don't create cron jobs / Task Scheduler entries yourself. The OS starts the run at
that time, outside this conversation. Schedules are one-shot; separate dates need separate schedules.

## Schedule a run

1. Resolve, as for `/sand:flow` ([`../flow/SKILL.md`](../flow/SKILL.md)): the flow (`list_flows` or
   `sandflow flows --json`; state the pick and why), the prompt (the task in the user's words), the repo
   (`--repo`, default the current git repo; say so) and any derivable inputs (`--env K=V`). Secrets are never
   passed on the command line: they must be set in Sandflow's Inputs tab (`sandflow --ui`).
2. Resolve the time:
   - a bare `HH:MM` means the next occurrence in the machine's local timezone;
   - natural language ("tomorrow at 9", "Friday 18:30") → an ISO date-time. Use the user's timezone when they
     give one, as an ISO timestamp with that explicit offset (e.g. `2026-11-02T09:00:00+02:00`); never silently
     substitute your own timezone for one they named. Without one, use the machine's local time.
   - a time already past today with no date → the next day; say so.
3. Register (quote every argument for the current shell):

   ```text
   sandflow schedule add --at "<ISO timestamp or HH:MM>" --repo "<repo>" -- run "<flow id or name>" "<prompt>" --env K=V
   ```

4. Check it: only report success when the command exits 0 **and** prints JSON with `state: "scheduled"`. Report the
   `id`, the returned `at` in the user's timezone, the flow and the repo. On failure report the error; never claim
   a schedule exists or fall back to waiting in the session.

## List, change, cancel

- `sandflow schedule list --json` → find the schedule (don't create a duplicate to "move" one).
- `sandflow schedule edit <id> --at "<time>"` → same time rules as above; keeps the id and the frozen flow, prompt
  and inputs. Check the exit code and the returned time before reporting. Started, finished or cancelled schedules
  can't be edited.
- `sandflow schedule cancel <id>` → removes the trigger. It does not stop a run that already started: use
  `/sand:flow stop` (`stop_run` / `sandflow stop <runId>`).
- Records and each scheduled run's output log live in `~/.sandflow/schedules/`.

## The hourly checker

Runs pause when Sandflow stops mid-run (crash, quit, reboot, update) or hit a transient limit. The checker
continues them unattended: an hourly OS task running `sandflow resume --paused`, which continues every paused run
that can continue (not ones held for a person). Offer it whenever the user schedules runs or asks for runs to
"keep going" / "survive a reboot".

- `sandflow checker install` (or the installer's `-Checker` / `--checker`), `sandflow checker status`,
  `sandflow checker uninstall`.
- Exit codes of a scheduled run or of the checker: **0** done; **75** paused / held, not failed, it will be
  continued (by the checker or `sandflow resume <runId>`); **3** waiting on a question, needs the user
  (`/sand:flow` answers it); **1** failed, needs the user (report the error from `sandflow status <runId> --json`).
- When the user asks how scheduled runs went: `sandflow runs --json`, then `sandflow status <runId> --json` for each.

## Platform notes

- Windows: Task Scheduler under the current user, no administrator rights or stored passwords; the user must be
  logged in.
- Linux: systemd user timers (`systemctl --user`); a working user systemd manager is needed. For runs while
  logged out, the user enables lingering (`loginctl enable-linger`) themselves.
- macOS: if `schedule add` reports it is unsupported, say so; don't improvise with `at`/`cron`.
- The machine must be on; a missed time runs when the scheduler next can. Sandflow must stay installed at the same
  path (`~/.sandflow`).
