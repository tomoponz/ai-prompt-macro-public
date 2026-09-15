import {
  MAX_SENDS_PER_RUN,
  MAX_WORKFLOW_BLOCKS,
  countPlannedSends,
  normalizeWorkflow
} from "./workflow.js";
import { countWorkflowStepTypes } from "./workflow-step-counts.js";

export const EXECUTION_MODES = ["full", "step", "from", "range", "range-repeat", "after-checkpoint"];

function parseBoundedInteger(value, label, min, max) {
  const raw = String(value ?? "");
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${label}は${min}〜${max}の整数で指定してください。`);
  const big = BigInt(raw);
  if (big < BigInt(min) || big > BigInt(max)) throw new Error(`${label}は${min}〜${max}で指定してください。`);
  return Number(big);
}

function cloneStep(step, sourceIndex, cycle) {
  return {
    ...JSON.parse(JSON.stringify(step)),
    id: `plan-${cycle + 1}-${sourceIndex + 1}-${step.id}`
  };
}

function selectionFor(workflow, spec) {
  const mode = EXECUTION_MODES.includes(spec?.mode) ? spec.mode : "full";
  const total = workflow.steps.length;
  if (mode === "full") {
    return { mode, start: 0, end: total - 1, cycles: 1, label: "Flow全体" };
  }

  if (mode === "after-checkpoint") {
    const checkpointId = String(spec?.checkpointId ?? "");
    const checkpointIndex = workflow.steps.findIndex((step) => step.type === "checkpoint" && step.id === checkpointId);
    if (checkpointIndex < 0) throw new Error("再開元のCheckpointを選択してください。");
    if (checkpointIndex + 1 >= total) throw new Error("選択したCheckpointの後に実行する手順がありません。");
    return {
      mode,
      start: checkpointIndex + 1,
      end: total - 1,
      cycles: 1,
      label: `Checkpoint「${workflow.steps[checkpointIndex].label}」の次から`
    };
  }

  const start = parseBoundedInteger(spec?.start, "開始手順", 1, total) - 1;
  const end = mode === "step"
    ? start
    : mode === "from"
      ? total - 1
      : parseBoundedInteger(spec?.end, "終了手順", 1, total) - 1;
  if (end < start) throw new Error("終了手順は開始手順以降を指定してください。");
  const cycles = mode === "range-repeat"
    ? parseBoundedInteger(spec?.repeat, "範囲の繰り返し", 1, MAX_SENDS_PER_RUN)
    : 1;
  const label = mode === "step"
    ? `手順 ${start + 1} のみ`
    : mode === "from"
      ? `手順 ${start + 1} から最後まで`
      : `手順 ${start + 1}〜${end + 1}${cycles > 1 ? ` × ${cycles}` : ""}`;
  return { mode, start, end, cycles, label };
}

export function buildExecutionPlan(compiledFlow, spec = { mode: "full" }) {
  if (!compiledFlow?.workflow) throw new Error("有効なcompiled Flowが必要です。");
  const sourceWorkflow = normalizeWorkflow(JSON.parse(JSON.stringify(compiledFlow.workflow)));
  const selection = selectionFor(sourceWorkflow, spec);

  if (selection.mode === "full") {
    return Object.freeze({
      workflow: sourceWorkflow,
      rangeLabel: selection.label,
      partial: false,
      repeatCycles: 1,
      sourceStart: 0,
      sourceEnd: sourceWorkflow.steps.length - 1
    });
  }

  const width = selection.end - selection.start + 1;
  const plannedBlocks = BigInt(width) * BigInt(selection.cycles);
  if (plannedBlocks > BigInt(MAX_WORKFLOW_BLOCKS)) {
    throw new Error(`部分実行planは${plannedBlocks} blocksです。上限は${MAX_WORKFLOW_BLOCKS}です。`);
  }

  const steps = [];
  for (let cycle = 0; cycle < selection.cycles; cycle += 1) {
    for (let sourceIndex = selection.start; sourceIndex <= selection.end; sourceIndex += 1) {
      steps.push(cloneStep(sourceWorkflow.steps[sourceIndex], sourceIndex, cycle));
    }
  }

  const rawPlan = {
    ...sourceWorkflow,
    id: `${sourceWorkflow.id}-partial`,
    name: `${sourceWorkflow.name} · ${selection.label}`,
    maxSends: MAX_SENDS_PER_RUN,
    steps
  };
  const plannedSends = countPlannedSends(rawPlan);
  if (plannedSends > MAX_SENDS_PER_RUN) {
    throw new Error(`部分実行planは${plannedSends}回送信予定です。上限は${MAX_SENDS_PER_RUN}回です。`);
  }
  rawPlan.maxSends = Math.max(1, plannedSends);
  const workflow = normalizeWorkflow(rawPlan);

  return Object.freeze({
    workflow,
    rangeLabel: selection.label,
    partial: true,
    repeatCycles: selection.cycles,
    sourceStart: selection.start,
    sourceEnd: selection.end
  });
}

export function summarizeExecutionPlan(compiledFlow, plan) {
  if (!compiledFlow?.workflow || !plan?.workflow) return null;
  const steps = plan.workflow.steps;
  const full = plan.partial !== true;
  return Object.freeze({
    flowName: String(compiledFlow.workflow.name ?? compiledFlow.name ?? ""),
    selectedFlow: String(compiledFlow.name ?? compiledFlow.workflow.name ?? ""),
    executionRange: plan.rangeLabel,
    plannedSends: countPlannedSends(plan.workflow),
    blocks: steps.length,
    repeatCommands: full
      ? Number(compiledFlow.preview?.repeatCommands ?? 0)
      : 0,
    repeatCycles: Number(plan.repeatCycles ?? 1),
    ...countWorkflowStepTypes(steps)
  });
}
