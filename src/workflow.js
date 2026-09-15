import { normalizeRecoveryPolicy } from "./recovery-policy.js";

export const SCHEMA_VERSION = 1;
export const MAX_SENDS_PER_RUN = 50;
export const MAX_WORKFLOW_BLOCKS = 40;
export const MIN_DELAY_MS = 0;
export const MAX_DELAY_MS = 5 * 60 * 1000;
export const MAX_WAIT_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_LATE_GRACE_MS = 5 * 60 * 1000;

export const STEP_TYPES = ["prompt", "delay", "wait-until", "checkpoint"];

export const QUICK_PRESETS = [
  {
    id: "improve",
    label: "さらに改善",
    prompt: "現在の状態を確認し、最も重要な改善点を1つだけ選び、最小限の変更で改善して検証してください。"
  },
  {
    id: "continue",
    label: "続ける",
    prompt: "前回までの作業を踏まえ、残っている中で最も価値の高い作業を1つ選んで続けてください。"
  },
  {
    id: "review",
    label: "厳格レビュー",
    prompt: "現在の成果物を厳しくレビューし、重大度の高い具体的な問題がある場合だけ1つ修正して検証してください。"
  }
];

const promptStep = (id, prompt, delayAfterMs = 1000) => ({
  id,
  type: "prompt",
  delivery: "send",
  prompt,
  repeat: 1,
  delayAfterMs
});

export const WORKFLOW_PRESETS = [
  {
    schemaVersion: SCHEMA_VERSION,
    id: "continuous-improvement",
    name: "継続的に改善",
    maxSends: 6,
    steps: [
      promptStep("analyze", "現在の成果物を変更せずに評価してください。具体的な問題を重要度順に最大3件だけ挙げてください。", 1500),
      promptStep("prioritize", "前の評価から最重要の問題を1つだけ選び、修正後に満たすべき検証基準を明確にしてください。", 1000),
      promptStep("improve", "その問題だけを最小限の変更で修正してください。無関係なリファクタリングや機能追加はしないでください。", 1500),
      promptStep("verify", "変更を検証してください。テスト・根拠・反例を優先し、実際に検証できない項目は未検証と明記してください。", 1500),
      promptStep("review", "今回の変更による回帰、過剰設計、新しく生じた問題がないか厳しくレビューしてください。", 1000),
      promptStep("fix-concrete-only", "確認できた具体的な問題がある場合だけ修正してください。問題が確認できない場合は変更を増やさないでください。", 0)
    ]
  },
  {
    schemaVersion: SCHEMA_VERSION,
    id: "bug-hunter",
    name: "バグを探して修正",
    maxSends: 5,
    steps: [
      promptStep("reproduce", "現在の成果物から、再現可能で影響の大きいバグまたは不整合を1つ特定してください。推測だけで大改修しないでください。"),
      promptStep("root-cause", "その問題の根本原因を切り分け、最小修正で直す方針を決めてください。"),
      promptStep("fix", "決めた最小修正を実施してください。無関係な変更はしないでください。"),
      promptStep("regression", "修正を再現手順と回帰テストの観点から検証してください。未実行の検証は成功扱いしないでください。"),
      promptStep("review", "今回の修正が別の不具合や過剰な変更を生んでいないか確認し、具体的な問題がある場合だけ修正してください。", 0)
    ]
  },
  {
    schemaVersion: SCHEMA_VERSION,
    id: "release-readiness",
    name: "リリース前チェック",
    maxSends: 5,
    steps: [
      promptStep("audit", "現在の成果物をリリース前提で監査し、BLOCKERまたはHIGHの問題だけを優先順位付きで挙げてください。"),
      promptStep("fix-blocker", "最重要のBLOCKER/HIGHがある場合だけ最小限で修正してください。なければ変更しないでください。"),
      promptStep("test", "リリース判定に必要なテストと検証を実施または確認してください。未実行項目は未検証と明記してください。"),
      promptStep("regression", "今回の変更による回帰と設定ミスを確認し、具体的な問題がある場合だけ修正してください。"),
      promptStep("final", "最終リリース判定を行い、残るリスクと未検証事項を明確にしてください。新しい変更は必要な場合だけ行ってください。", 0)
    ]
  }
];

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function sanitizeId(value, fallback) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function normalizeIsoDate(value, index) {
  const raw = String(value ?? "").trim();
  const timestamp = Date.parse(raw);
  if (!raw || !Number.isFinite(timestamp)) throw new Error(`Block ${index + 1} の時刻が不正です。`);
  return new Date(timestamp).toISOString();
}

export function normalizeQuickConfig(input = {}) {
  const prompt = String(input.prompt ?? "").trim();
  if (!prompt) throw new Error("プロンプトを入力してください。");

  const repeat = clampInteger(input.repeat, 1, MAX_SENDS_PER_RUN, 1);
  const delayAfterMs = clampInteger(
    Math.round(Number(input.delaySeconds ?? 1.5) * 1000),
    MIN_DELAY_MS,
    MAX_DELAY_MS,
    1500
  );

  return { prompt, repeat, delayAfterMs };
}

export function quickConfigToWorkflow(input = {}) {
  const config = normalizeQuickConfig(input);
  return {
    schemaVersion: SCHEMA_VERSION,
    id: "quick-macro",
    name: "かんたん実行",
    maxSends: config.repeat,
    steps: [
      {
        id: "quick",
        type: "prompt",
        delivery: "send",
        prompt: config.prompt,
        repeat: config.repeat,
        delayAfterMs: config.delayAfterMs
      }
    ]
  };
}

export function classifyWaitUntilAtStart(step, nowMs) {
  if (step?.type !== "wait-until") return null;

  const now = Number(nowMs);
  if (!Number.isFinite(now)) throw new TypeError("Start preflightには有限の現在時刻が必要です。");

  const scheduledAt = Date.parse(step.at);
  const graceMs = Number(step.graceMs);
  if (!Number.isFinite(scheduledAt) || !Number.isFinite(graceMs) || graceMs < 0) {
    return { state: "invalid", stepId: String(step.id ?? "") };
  }

  const latenessMs = now - scheduledAt;
  if (latenessMs <= 0) {
    return { state: "future", stepId: step.id, scheduledAt, graceMs, latenessMs };
  }
  if (latenessMs <= graceMs) {
    return { state: "past-within-grace", stepId: step.id, scheduledAt, graceMs, latenessMs };
  }

  const latePolicy = ["pause", "run", "skip"].includes(step.latePolicy) ? step.latePolicy : "pause";
  return { state: `stale-${latePolicy}`, stepId: step.id, scheduledAt, graceMs, latenessMs };
}

export function preflightWorkflowStartSchedule(workflow, nowMs) {
  const observations = (workflow?.steps ?? [])
    .map((step) => classifyWaitUntilAtStart(step, nowMs))
    .filter(Boolean);
  const blocker = observations.find((item) => item.state === "stale-pause" || item.state === "invalid") ?? null;
  return { ok: blocker == null, blocker, observations };
}

export function normalizeWorkflow(input = {}) {
  if (Number(input.schemaVersion ?? SCHEMA_VERSION) !== SCHEMA_VERSION) {
    throw new Error(`未対応のworkflow schemaVersionです: ${input.schemaVersion}`);
  }

  const sourceSteps = Array.isArray(input.steps) ? input.steps : [];
  if (sourceSteps.length === 0) throw new Error("Workflowに1つ以上のblockが必要です。");
  if (sourceSteps.length > MAX_WORKFLOW_BLOCKS) throw new Error("Workflowのblock数が多すぎます。");

  const steps = sourceSteps.map((step, index) => {
    // Schema 1 historically omitted these enums. Only missing own fields may
    // migrate; an explicit unknown value must never acquire Send authority.
    const type = Object.hasOwn(step ?? {}, "type") ? step.type : "prompt";
    if (!STEP_TYPES.includes(type)) throw new Error(`Block ${index + 1} の種類に未対応の値があります。`);
    const id = sanitizeId(step?.id, `block-${index + 1}`);

    if (type === "checkpoint") {
      return {
        id,
        type,
        label: String(step?.label ?? "Manual checkpoint").trim() || "Manual checkpoint"
      };
    }

    if (type === "delay") {
      return {
        id,
        type,
        durationMs: clampInteger(step?.durationMs, 0, MAX_WAIT_MS, 5000)
      };
    }

    if (type === "wait-until") {
      const latePolicy = ["pause", "run", "skip"].includes(step?.latePolicy) ? step.latePolicy : "pause";
      return {
        id,
        type,
        at: normalizeIsoDate(step?.at, index),
        latePolicy,
        graceMs: clampInteger(step?.graceMs, 0, MAX_WAIT_MS, DEFAULT_LATE_GRACE_MS)
      };
    }

    const prompt = String(step?.prompt ?? "").trim();
    if (!prompt) throw new Error(`Block ${index + 1} のプロンプトが空です。`);
    const delivery = Object.hasOwn(step ?? {}, "delivery") ? step.delivery : "send";
    if (!["send", "draft"].includes(delivery)) throw new Error(`Block ${index + 1} の送信方法に未対応の値があります。`);

    return {
      id,
      type,
      delivery,
      prompt,
      repeat: delivery === "draft" ? 1 : clampInteger(step?.repeat, 1, MAX_SENDS_PER_RUN, 1),
      delayAfterMs: delivery === "draft"
        ? 0
        : clampInteger(step?.delayAfterMs, MIN_DELAY_MS, MAX_DELAY_MS, 1000)
    };
  });

  const stepIds = new Set();
  for (const step of steps) {
    if (stepIds.has(step.id)) throw new Error(`Workflowのblock IDが重複しています: ${step.id}`);
    stepIds.add(step.id);
  }

  const plannedSends = countPlannedSends({ steps });
  const requestedMax = clampInteger(input.maxSends, 1, MAX_SENDS_PER_RUN, Math.max(1, Math.min(MAX_SENDS_PER_RUN, plannedSends || 1)));
  if (plannedSends > requestedMax) {
    throw new Error(`Workflowは${plannedSends}回送信予定ですが、maxSendsは${requestedMax}です。`);
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    id: sanitizeId(input.id, "custom-workflow"),
    name: String(input.name ?? "カスタム自動化フロー").trim() || "カスタム自動化フロー",
    maxSends: requestedMax,
    recovery: normalizeRecoveryPolicy(input.recovery),
    steps
  };
}

export function countPlannedSends(workflow = {}) {
  return (workflow.steps ?? []).reduce((total, step) => {
    if (step?.type !== "prompt" || step?.delivery === "draft") return total;
    return total + Math.max(1, Number(step?.repeat ?? 1));
  }, 0);
}

export function countPlannedActions(workflow = {}) {
  return (workflow.steps ?? []).reduce((total, step) => {
    if (step?.type === "prompt" && step?.delivery !== "draft") return total + Math.max(1, Number(step?.repeat ?? 1));
    return total + 1;
  }, 0);
}

export function getCursorStep(workflow, cursor = {}) {
  const stepIndex = Number(cursor.stepIndex ?? 0);
  const step = workflow.steps?.[stepIndex] ?? null;
  if (!step) return null;
  return { step, stepIndex, repeatIndex: Number(cursor.repeatIndex ?? 0) };
}

export function advanceCursor(workflow, cursor = {}) {
  const current = getCursorStep(workflow, cursor);
  if (!current) return { ...cursor, done: true };

  const isSend = current.step.type === "prompt" && current.step.delivery !== "draft";
  const repeat = isSend ? Math.max(1, Number(current.step.repeat ?? 1)) : 1;
  if (isSend && current.repeatIndex + 1 < repeat) {
    return {
      stepIndex: current.stepIndex,
      repeatIndex: current.repeatIndex + 1,
      sendsCompleted: Number(cursor.sendsCompleted ?? 0) + 1,
      done: false
    };
  }

  const sendsCompleted = Number(cursor.sendsCompleted ?? 0) + (isSend ? 1 : 0);
  const nextIndex = current.stepIndex + 1;
  return {
    stepIndex: nextIndex,
    repeatIndex: 0,
    sendsCompleted,
    done: nextIndex >= workflow.steps.length
  };
}

export function clonePreset(id) {
  const preset = WORKFLOW_PRESETS.find((item) => item.id === id) ?? WORKFLOW_PRESETS[0];
  return JSON.parse(JSON.stringify(preset));
}

export function defaultBlock(type = "prompt") {
  const id = `block-${cryptoRandomId()}`;
  if (type === "delay") return { id, type, durationMs: 5000 };
  if (type === "wait-until") {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    future.setSeconds(0, 0);
    return { id, type, at: future.toISOString(), latePolicy: "pause", graceMs: DEFAULT_LATE_GRACE_MS };
  }
  if (type === "checkpoint") return { id, type, label: "確認してから続行" };
  return { id, type: "prompt", delivery: "send", prompt: "次の作業を実行してください。", repeat: 1, delayAfterMs: 1000 };
}

function cryptoRandomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().slice(0, 8);
  return Math.random().toString(36).slice(2, 10);
}
