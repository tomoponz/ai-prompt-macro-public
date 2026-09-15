/*
  Shared initial editor defaults.

  Settings are consulted only when an exact tab has no editor entry. The
  resulting six-field value is ordinary authoring state: it has no Run,
  target, document, conversation, lease or Send authority. Once an entry is
  saved, both surfaces load that entry and never re-apply Settings to it.
*/

import { normalizeRecoveryPolicy } from "./recovery-policy.js";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  normalizeSettings
} from "./settings-store.js";
import {
  MAX_SENDS_PER_RUN,
  QUICK_PRESETS,
  clonePreset,
  countPlannedSends
} from "./workflow.js";

export const DEFAULT_EDITOR_FLOW_TEXT = `flow qa {
  send """
    現在の実装をレビューしてください。
  """

  repeat 3 {
    send """
      前回までを踏まえ、次に重要な問題を1つ探してください。
    """
  }

  checkpoint "確認"
}`;

function initialWorkflow(maxSends) {
  const workflow = clonePreset("continuous-improvement");
  const budget = Math.min(MAX_SENDS_PER_RUN, Math.max(1, maxSends));
  let remaining = budget;
  /* The built-in preset currently contains one Send per step. Keep this
     projection generic enough for a future repeated Send: a valid Settings
     value is the exact new-editor ceiling, so only the initial preset copy is
     shortened when its plan would exceed that ceiling. */
  workflow.steps = workflow.steps.flatMap((step) => {
    if (step.type !== "prompt" || step.delivery !== "send") return [step];
    if (remaining <= 0) return [];
    const repeat = Number.isSafeInteger(step.repeat) && step.repeat > 0 ? step.repeat : 1;
    const admitted = Math.min(repeat, remaining);
    remaining -= admitted;
    return [{ ...step, repeat: admitted }];
  });
  workflow.maxSends = budget;
  if (countPlannedSends(workflow) < 1) {
    throw new Error("新規Workflowの送信計画を初期化できませんでした。");
  }
  return workflow;
}

export function createEditorInitialState(settingsInput = DEFAULT_SETTINGS, {
  mode = "quick"
} = {}) {
  const settings = normalizeSettings(settingsInput);
  const quickPreset = QUICK_PRESETS[0];
  const recovery = normalizeRecoveryPolicy({ mode: settings.defaults.recoveryMode });

  return {
    mode: ["quick", "workflow", "flow"].includes(mode) ? mode : "quick",
    keepAwake: settings.defaults.keepAwake,
    recovery,
    quick: {
      preset: quickPreset.id,
      prompt: quickPreset.prompt,
      repeat: "3",
      delay: String(settings.defaults.delaySeconds)
    },
    workflow: initialWorkflow(settings.defaults.maxSends),
    flow: {
      text: DEFAULT_EDITOR_FLOW_TEXT,
      selectedIndex: 0,
      openedLibraryId: null,
      execution: {
        mode: "full",
        start: "1",
        end: "1",
        repeat: "1",
        checkpointId: ""
      }
    }
  };
}

/* loadSettings() never throws. A storage failure therefore produces the same
   normalized safe defaults as an empty store, while exposing a bounded status
   to tests/callers that need to distinguish confirmed Settings from fallback. */
export async function loadEditorInitialState({
  storageArea = null,
  mode = "quick"
} = {}) {
  const loaded = await loadSettings(storageArea);
  return Object.freeze({
    state: createEditorInitialState(loaded.settings, { mode }),
    settingsConfirmed: loaded.ok === true,
    error: loaded.error
  });
}
