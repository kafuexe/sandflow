# Sandflow base boxes

The blocks ("boxes"), templates and example flows [Sandflow](https://github.com/kafuexe/sandflow) starts with. Sandflow
installs this pack on first start, and ships a copy so it also works offline.

It's also the **template for making your own pack**: click **Use this template** on GitHub, then follow
[Make your own pack](#make-your-own-pack).

| | |
|---|---|
| **Templates** | AI Agent, Git Automation, Reviewer, Trigger |
| **Blocks** | Create task, Plan, Implement, CR, CR fix, Manager, Create MR, Shell command, Changed files (Script), Manual start, Schedule, GitHub / GitLab trigger, If, Answer comment, Post comment |
| **Flows** | Feature pipeline · Feature pipeline (review subflow) · Review until approved (a subflow) · MR comment assistant · Daily repo report |
| **Skills** | [obra/superpowers](https://github.com/obra/superpowers) and [mattpocock/skills](https://github.com/mattpocock/skills) (vendored, with their licenses) |

## Add a pack to Sandflow

**Packs → Add pack**, then one of:

- **GitHub / GitLab link** — `https://github.com/you/your-pack`, a tag or branch (`…/tree/v1.2.0`), or a folder inside a repo
  (`…/tree/main/packs/review`). Self-hosted GitLab works. Without a ref Sandflow takes the latest release (else the
  default branch) and pins the exact commit. Private repos: set `GITHUB_TOKEN` / `GITLAB_TOKEN` in Inputs.
- **Folder** — copy it in, or **link** it (changes show up live — use this while building a pack).
- **Zip** — e.g. one made with **Packs → Share my blocks**.

Before anything is installed you see what the pack contains, **every command it can run**, which other packs it needs
and — for updates — which files changed.

## Pack layout

```
manifest.json          required
boxes/*.json           blocks and templates (one per file, or an array)
flows/*.json           flows
skills/<dir>/SKILL.md  skills your blocks install into the agent's sandbox
scripts/, bin/, …      anything else your Script blocks use
Dockerfile             optional: the container your Script blocks run in
```

### `manifest.json`

```jsonc
{
  "id": "review-tools",            // lowercase letters, digits, dashes — your blocks become review-tools/<id>
  "name": "Review tools",
  "version": "1.2.0",              // semver; bump it on every release
  "description": "…",
  "author": "you",
  "license": "MIT",
  "requires": [                    // other packs you use (e.g. you extend base/tpl-ai-agent)
    { "id": "base", "version": "^1.0.0", "source": "https://github.com/kafuexe/sandflow-base-boxes" }
  ],
  "setup": "pip install -r requirements.txt -t .deps",   // optional, runs once per version, in the pack's own copy
  "sandbox": { "dockerfile": "Dockerfile" },             // optional: or { "image": "python:3.12-slim" }
  "bin": { "mytool": { "linux-x64": "bin/linux-x64/mytool", "linux-arm64": "bin/linux-arm64/mytool" } }
}
```

### Ids and references

Inside a pack, ids are short: `plan`, `review-loop`. Sandflow prefixes them with the pack id when it loads the pack
(`review-tools/plan`), so packs never overwrite each other's blocks. To use something from another pack write its full id
(`base/tpl-ai-agent`) and list that pack under `requires`. Sandflow's own blocks are `sandflow/subflow`,
`sandflow/flow-input`, `sandflow/flow-output` and `sandflow/script`.

### Blocks — `boxes/<id>.json`

The same shape Sandflow's block editor saves:

```json
{
  "id": "strict-review",
  "name": "Strict review",
  "isTemplate": false,
  "extends": "base/tpl-reviewer",
  "config": {
    "description": "Reviews only for security problems.",
    "extraInstructions": "Only report security issues. Follow $PACK_DIR/checklists/security.md.",
    "skills": [{ "name": "security-review", "file": { "store": "pack", "dir": "security-review" } }]
  }
}
```

AI blocks can read the pack's files at `$PACK_DIR` (read-only).

### Script blocks — real code

```json
{
  "id": "lint-report",
  "name": "Lint report",
  "isTemplate": false,
  "config": {
    "kind": "script",
    "env": ["REPO_PATH"],
    "inputs": { "artifact": true },
    "outputs": { "artifact": true },
    "script": { "run": "python \"$PACK_DIR/scripts/lint.py\"", "exits": ["clean", "issues"] }
  }
}
```

The contract, for any language:

- **In:** JSON on stdin (also in the file `$SANDFLOW_INPUT`): `artifact`, `steer`, `startingPrompt`, `trigger`, `node`,
  `run`, `env`. The block's declared env vars are environment variables too.
- **Out:** write `{"artifact": "…", "steer": "…", "exit": "issues"}` to `$SANDFLOW_OUTPUT` — or just print the artifact.
- **Exits:** with `exits`, the node gets one handle per exit and the flow continues out of the one you return.
- **`$PACK_DIR`** is a writable copy of the pack where `setup` already ran and your `bin` executables are on `PATH`.
  Every pack (and version) gets its own copy, so dependencies of different packs never clash.
- **Where it runs:** in the run's sandbox when the block needs `REPO_PATH` (git works there), otherwise in a throwaway
  container — your pack's image if you set `sandbox`. On the user's machine only with `"where": "host"` (or when their
  sandbox is off), and only if they allow your pack to run code there.

The default image (`sandflow-agent`) has Node 22, git and jq. Need Python or other tools? Ship a `Dockerfile` (built
on the user's machine) or name an `image`. Note: with your own image the repo is mounted at `/work` without git metadata.

### Flows and subflows — `flows/<id>.json`

A flow is nodes + edges, as Sandflow saves them. To make a flow usable **inside other flows**, add:

- a **Flow input** (`sandflow/flow-input`) — where it starts; switch off `artifact`/`steer` outputs it doesn't use;
- one or more **Flow output** blocks (`sandflow/flow-output`) with `"overrides": { "flowOutput": { "name": "approved" } }`.

Dropped on another flow's canvas it becomes one node with those inputs and one exit per output name
(`review.exit:approved -> merge`). See `flows/review-until-approved.json` and `flows/feature-pipeline-with-review.json`.

## Make your own pack

1. **Use this template** (or start from **Packs → Share my blocks** in Sandflow, which writes a pack from blocks you built
   in the app).
2. Change `manifest.json`: your own `id`, `name`, `version: 0.1.0`, and `requires: [{ "id": "base", "version": "^1.0.0", "source": "https://github.com/kafuexe/sandflow-base-boxes" }]`.
3. Delete what you don't want from `boxes/`, `flows/`, `skills/`, `scripts/`.
4. In Sandflow: **Packs → Add pack → Folder**, tick **Link** — edit the files and see the changes live.
5. `node tools/check-pack.mjs` (also runs in CI) catches broken JSON, unknown ids and missing files.
6. Push, then tag a release (`git tag v0.1.0 && git push --tags`, or a GitHub release). People add it with the repo link;
   **Check for update** picks up new releases.

## License

MIT for this repository's own files. The skills under `skills/` keep their own licenses (see each folder).
