# Watching a run

`watch_run {runId, after?, timeoutSeconds?}` waits until the run has news after the cursor and returns
`{runId, status, phase?, pendingQuestion?, hold?, events, cursor, ended, timedOut?}`. Pass `cursor` back as `after`
on the next call. Omit `after` to get every event from the start (use that to catch up after your session was cut
off or compacted: nothing is lost, events are kept in the run).

## Events

| Event | Meaning | What to tell / do |
|---|---|---|
| `node` done | A step finished | One line: "Plan done." Mention its output only when it matters (a plan summary, an MR link) |
| `node` failed | A step failed | The step and its error. Recovery usually follows (next row) |
| `recovery` | Recovery acted on a failed step: `cause` (error, crash, transient, timeout, stuck, sandbox) and a `decision` | `retry` / `resume` / `rescope`: one line ("Implement crashed, retrying"). `skip`: say which step was skipped. `blocked` / `hold` with a `guard`: the run needs a person, see Hold |
| `question` with `pending` | A step waits for an answer | Answer from what the user already said (`answer_question`), otherwise ask the user verbatim and pass their answer on |
| `flag` | Something needs a look (stuck agent, warning) | Tell the user |
| supervisor events | A step is silent / stuck / over its time limit / looping / lost its container, a reminder of an unanswered question, the overseer's verdict | Tell the user once; don't repeat the same reminder |
| `phase` `interrupted` / `paused` | Sandflow stopped mid-run (crash, quit, update, `sandflow shutdown`) | Say so. It continues when Sandflow runs again (unless turned off for the flow), or when the hourly checker runs `sandflow resume --paused`. Keep watching |
| `phase` paused with `hold` | Recovery held the run for a person | Tell the user `hold.reason` and what to fix. It waits until they fix it and continue (Continue in the UI, or ask you to continue it). Keep watching |
| `phase` `continuing` | The run picked up where it stopped (`attempt` counts continuations) | One line |
| `end`, `phase` `done` / `failed` / `cancelled` | The run is over (`ended: true`) | Final report |

## Final report

Call `get_run` and report:

- status (`done`, `failed`, `cancelled`) and how long it ran;
- what each step produced, briefly; the last step's output is usually the result (an MR/PR link, a summary, an
  answer), give it in full when it is short;
- errors, open flags, the cost when shown;
- for `failed`: the failing step, its error, and the next step (fix the cause, then `/sand:flow continue <runId>`).

Never say "done" or "verified" for anything the run didn't report.

## Long runs

Runs can take a long time. Each `watch_run` returns within ~9 minutes, so a watch loop never blocks for longer
than that. If the user wants to do something else meanwhile, stop watching: the run carries on. Later,
`get_run` (status) or `watch_run` without a cursor catches up.
