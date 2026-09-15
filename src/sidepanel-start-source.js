/*
  Phase 4D Start source boundary.

  Start resolves one exact target tab from `aipm.uiByTab.v2`, after any visible
  Quick/Flow draft has been saved through the editor revision fence. It
  validates the saved editor state through the existing compiler/normalizers,
  and returns a detached Workflow snapshot. Workspace DOM, Side Panel hidden
  compatibility controls and editorRevision are deliberately outside the
  returned Run payload.
*/
import { buildExecutionPlan } from "./execution-plan.js";
import { compileAipmFlow } from "./flow-compile.js";
import { normalizeRecoveryPolicy } from "./recovery-policy.js";
import { readUiStateForTab } from "./ui-state-store.js";
import {
  countPlannedSends,
  normalizeWorkflow,
  quickConfigToWorkflow
} from "./workflow.js";

export const START_SOURCE_ERROR_CODES = Object.freeze({
  EDITOR_STATE_MISSING: "START_EDITOR_STATE_MISSING",
  EDITOR_STATE_INVALID: "START_EDITOR_STATE_INVALID",
  EDITOR_STATE_CHANGED: "START_EDITOR_STATE_CHANGED"
});

export class StartSourceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StartSourceError";
    this.code = code;
  }
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function invalid() {
  return new StartSourceError(
    START_SOURCE_ERROR_CODES.EDITOR_STATE_INVALID,
    "保存済みの実行内容を安全に検証できません。Workspaceで内容を確認して保存してください。"
  );
}

function resolveWorkflow(entry, recovery) {
  if (entry.mode === "quick") {
    const quick = plainObject(entry.quick);
    if (!quick) throw invalid();
    return normalizeWorkflow({
      ...quickConfigToWorkflow({
        prompt: quick.prompt,
        repeat: quick.repeat,
        delaySeconds: quick.delay
      }),
      recovery
    });
  }

  if (entry.mode === "workflow") {
    const workflow = plainObject(entry.workflow);
    if (!workflow) throw invalid();
    // Normalize before any JSON clone could erase an explicit undefined enum.
    // The normalizer returns detached steps without mutating this saved source.
    return normalizeWorkflow({ ...workflow, recovery });
  }

  if (entry.mode === "flow") {
    const flow = plainObject(entry.flow);
    if (!flow || typeof flow.text !== "string" || !plainObject(flow.execution)) throw invalid();
    const selectedIndex = flow.selectedIndex;
    if (!Number.isSafeInteger(selectedIndex) || selectedIndex < 0) throw invalid();
    const compiled = compileAipmFlow(flow.text);
    const selected = compiled.flows?.[selectedIndex];
    if (!selected) throw invalid();
    const plan = buildExecutionPlan(selected, flow.execution);
    return normalizeWorkflow({ ...clone(plan.workflow), recovery });
  }

  throw invalid();
}

export function resolveStartSourceFromEditorEntry(entry) {
  const source = plainObject(entry);
  if (!source || !["quick", "workflow", "flow"].includes(source.mode)) throw invalid();

  try {
    const recovery = normalizeRecoveryPolicy(source.recovery);
    const workflow = resolveWorkflow(source, recovery);
    return Object.freeze({
      mode: source.mode,
      keepAwake: source.keepAwake === true,
      workflow,
      summary: Object.freeze({
        mode: source.mode,
        blocks: workflow.steps.length,
        plannedSends: countPlannedSends(workflow)
      })
    });
  } catch (error) {
    if (error?.code === START_SOURCE_ERROR_CODES.EDITOR_STATE_INVALID) throw error;
    /* Parser and normalizer failures are intentionally collapsed. They may
       carry source excerpts; the Run Cockpit only needs a bounded diagnosis. */
    throw invalid();
  }
}

// Editor-only comparison: never included in the Run payload or used as target authority.
export function editorStartSourceKey(entry) {
  const execution = entry?.flow?.execution;
  const content = entry?.mode === "flow"
    ? [entry.flow?.text, entry.flow?.selectedIndex,
      [execution?.mode, execution?.start, execution?.end, execution?.repeat, execution?.checkpointId]]
    : entry?.mode === "quick"
      ? [entry.quick?.prompt, entry.quick?.repeat, entry.quick?.delay]
      : normalizeWorkflow(entry?.workflow);
  // Chrome storage may reorder object keys. Compare named values and their
  // types, not serialization order, without normalizing a different Flow choice.
  return JSON.stringify([entry?.mode, entry?.keepAwake === true, normalizeRecoveryPolicy(entry?.recovery), content]);
}

export async function readStartSourceForTab(tabId, options = {}) {
  const read = await readUiStateForTab(tabId, options);
  if (!read.exists || !read.entry) {
    throw new StartSourceError(
      START_SOURCE_ERROR_CODES.EDITOR_STATE_MISSING,
      "この対象タブには保存済みの実行内容がありません。Quick PromptまたはWorkspaceで保存してください。"
    );
  }
  if (options.expectedEntry && editorStartSourceKey(read.entry) !== editorStartSourceKey(options.expectedEntry)) {
    throw new StartSourceError(
      START_SOURCE_ERROR_CODES.EDITOR_STATE_CHANGED,
      "保存済みの内容が確認した内容と変わったため、開始しませんでした。入力内容を確認し直してください。"
    );
  }
  return resolveStartSourceFromEditorEntry(read.entry);
}
