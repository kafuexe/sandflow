// Blocks built into Sandflow itself — engine primitives that work without any pack installed.
// They live in the reserved `sandflow` pack, so their ids are `sandflow/<id>`.

import { CORE_PACK } from "./packs";
import type { BlockDef } from "./types";

export const SUBFLOW_BLOCK = `${CORE_PACK}/subflow`;
export const FLOW_INPUT_BLOCK = `${CORE_PACK}/flow-input`;
export const FLOW_OUTPUT_BLOCK = `${CORE_PACK}/flow-output`;
export const SCRIPT_BLOCK = `${CORE_PACK}/script`;
export const STACK_BLOCK = `${CORE_PACK}/stack`;
export const MERGE_PARENT_BLOCK = `${CORE_PACK}/merge-parent`;

export const CORE_BLOCKS: BlockDef[] = [
  {
    id: SUBFLOW_BLOCK,
    name: "Subflow",
    isTemplate: false,
    pack: CORE_PACK,
    config: {
      kind: "subflow",
      description: "Runs another flow as one step. Its inputs come from that flow's Flow input, its exits from its Flow outputs.",
      color: "#a855f7",
      icon: "workflow",
      inputs: { artifact: true, steer: true, startingPrompt: false },
      outputs: { artifact: false, steer: false },
    },
  },
  {
    id: STACK_BLOCK,
    name: "Box Stack",
    isTemplate: false,
    pack: CORE_PACK,
    config: {
      kind: "stack",
      description:
        "An orchestrator splits the input into tasks, runs a flow for each task (several at once) and combines the " +
        "results into one output. Leaves through done, or failed when no task succeeded.",
      color: "#f97316",
      icon: "layers",
      env: ["REPO_PATH"],
      inputs: { artifact: true, steer: true, startingPrompt: false },
      outputs: { artifact: false, steer: false },
    },
  },
  {
    id: MERGE_PARENT_BLOCK,
    name: "Merge into parent branch",
    isTemplate: false,
    pack: CORE_PACK,
    config: {
      kind: "auto",
      autoAction: "merge-parent",
      description:
        "Inside a Box Stack task with an isolated workspace: merges this task's branch into the branch the stack was " +
        "cut from, one task at a time. A conflict fails the step.",
      color: "#f97316",
      icon: "git-merge",
      inputs: { artifact: true, steer: false, startingPrompt: false },
      outputs: { artifact: true, steer: false },
    },
  },
  {
    id: FLOW_INPUT_BLOCK,
    name: "Flow input",
    isTemplate: false,
    pack: CORE_PACK,
    config: {
      kind: "flow-input",
      description:
        "Where this flow starts when it runs as a subflow: hands on the artifact/steer the parent sent in. " +
        "Run on its own, it hands on the starting prompt as the artifact.",
      color: "#64748b",
      icon: "log-in",
      inputs: { artifact: false, steer: false, startingPrompt: false },
      outputs: { artifact: true, steer: true },
    },
  },
  {
    id: FLOW_OUTPUT_BLOCK,
    name: "Flow output",
    isTemplate: false,
    pack: CORE_PACK,
    config: {
      kind: "flow-output",
      description: "Ends this flow and hands its input back to the parent flow, out of the exit with this output's name.",
      color: "#64748b",
      icon: "log-out",
      inputs: { artifact: true, steer: true, startingPrompt: false },
      outputs: { artifact: false, steer: false },
      flowOutput: { name: "done" },
    },
  },
  {
    id: SCRIPT_BLOCK,
    name: "Script",
    isTemplate: false,
    pack: CORE_PACK,
    config: {
      kind: "script",
      description:
        "Runs a command in a container (or on this machine when trusted). Gets its inputs as JSON on stdin and " +
        "writes {artifact, steer, exit} to $SANDFLOW_OUTPUT (or prints the artifact).",
      color: "#0d9488",
      icon: "file-code",
      inputs: { artifact: true, steer: true, startingPrompt: false },
      outputs: { artifact: true, steer: true },
      script: { run: "", where: "sandbox", exits: [] },
    },
  },
];
