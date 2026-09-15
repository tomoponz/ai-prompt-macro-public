import { AipmFlowError, parseAipmFlow } from "./flow-script.js";
import {
  MAX_SENDS_PER_RUN,
  MAX_WORKFLOW_BLOCKS,
  SCHEMA_VERSION,
  countPlannedSends,
  normalizeWorkflow
} from "./workflow.js";
import { countWorkflowStepTypes } from "./workflow-step-counts.js";

export const MAX_COMPILED_FLOW_STEPS = MAX_WORKFLOW_BLOCKS;

export function compileAipmFlow(text) {
  const parsed = parseAipmFlow(text);
  const flows = parsed.flows.map((flow, flowIndex) => compileFlow(flow, flowIndex, text));

  return {
    version: parsed.version,
    flows
  };
}

function compileFlow(flow, flowIndex, source) {
  const expandedSteps = [];
  expandFlowSteps(flow.steps, expandedSteps, source);
  const compacted = compactAdjacentPromptSteps(expandedSteps);
  const preview = {
    repeatCommands: countSourceCommands(flow.steps, "repeat"),
    ...countWorkflowStepTypes(expandedSteps)
  };

  if (compacted.length > MAX_COMPILED_FLOW_STEPS) {
    throw new AipmFlowError(
      "WORKFLOW_TOO_MANY_BLOCKS",
      `Flow「${boundedFlowName(flow.name)}」は既存Workflowへ変換すると${compacted.length} blocksになります。現在の上限は${MAX_COMPILED_FLOW_STEPS} blocksです。`,
      source,
      0
    );
  }

  const workflow = normalizeWorkflow({
    schemaVersion: SCHEMA_VERSION,
    id: `aipm-${flowIndex + 1}-${flow.name}`,
    name: flow.name,
    maxSends: Math.max(1, flow.plannedSends),
    steps: compacted.map((item, stepIndex) => {
      if (item.type === "checkpoint") {
        return {
          id: `flow-${flowIndex + 1}-checkpoint-${stepIndex + 1}`,
          type: "checkpoint",
          label: item.label
        };
      }
      if (item.type === "delay") {
        return {
          id: `flow-${flowIndex + 1}-delay-${stepIndex + 1}`,
          type: "delay",
          durationMs: item.durationMs
        };
      }
      if (item.type === "wait-until") {
        return {
          id: `flow-${flowIndex + 1}-wait-until-${stepIndex + 1}`,
          type: "wait-until",
          at: item.at,
          latePolicy: item.latePolicy,
          graceMs: item.graceMs
        };
      }
      return {
        id: `flow-${flowIndex + 1}-send-${stepIndex + 1}`,
        type: "prompt",
        delivery: "send",
        prompt: item.prompt,
        repeat: item.repeat,
        delayAfterMs: 1000
      };
    })
  });

  const plannedSends = countPlannedSends(workflow);
  if (plannedSends !== flow.plannedSends || plannedSends > MAX_SENDS_PER_RUN) {
    throw new AipmFlowError(
      "COMPILE_SEND_COUNT_MISMATCH",
      `Flow「${boundedFlowName(flow.name)}」の送信予定数を安全に変換できませんでした。`,
      source,
      0
    );
  }

  return {
    name: flow.name,
    plannedSends,
    preview,
    workflow
  };
}

function countSourceCommands(steps, type) {
  return steps.reduce((total, step) => {
    const own = step?.type === type ? 1 : 0;
    return total + own + (step?.type === "repeat" ? countSourceCommands(step.steps, type) : 0);
  }, 0);
}

function expandFlowSteps(steps, output, source) {
  for (const step of steps) {
    if (step?.type === "send") {
      output.push({ type: "prompt", prompt: step.prompt });
      continue;
    }

    if (step?.type === "checkpoint") {
      output.push({ type: "checkpoint", label: step.label });
      continue;
    }

    if (step?.type === "wait") {
      output.push({ type: "delay", durationMs: step.durationMs });
      continue;
    }

    if (step?.type === "wait-until") {
      output.push({
        type: "wait-until",
        at: step.at,
        latePolicy: step.latePolicy,
        graceMs: step.graceMs
      });
      continue;
    }

    if (step?.type === "repeat") {
      for (let index = 0; index < step.count; index += 1) {
        expandFlowSteps(step.steps, output, source);
      }
      continue;
    }

    throw new AipmFlowError(
      "INVALID_AST",
      "内部Flow構造が不正なためWorkflowへ変換できません。",
      source,
      Number(step?.offset ?? 0)
    );
  }
}

function compactAdjacentPromptSteps(steps) {
  const compacted = [];

  for (const step of steps) {
    const previous = compacted[compacted.length - 1];
    if (
      step.type === "prompt" &&
      previous?.type === "prompt" &&
      previous.prompt === step.prompt &&
      previous.repeat < MAX_SENDS_PER_RUN
    ) {
      previous.repeat += 1;
    } else if (step.type === "prompt") {
      compacted.push({ type: "prompt", prompt: step.prompt, repeat: 1 });
    } else {
      compacted.push({ ...step });
    }
  }

  return compacted;
}

function boundedFlowName(value) {
  const name = String(value ?? "");
  return name.length <= 80 ? name : `${name.slice(0, 80)}…`;
}
