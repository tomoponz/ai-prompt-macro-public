import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { completionOutcomeForRun, projectRunState, projectRunUx } from "../src/run-ux.js";

const sidepanelHtml = fs.readFileSync(new URL("../src/sidepanel.html", import.meta.url), "utf8");

const primaryStates = [
  null,
  { status: "running" },
  { status: "paused", pauseReason: "user-pause", resumable: true },
  { status: "paused", pauseReason: "manual-checkpoint", resumable: true },
  { status: "paused", pauseReason: "submission_ambiguous", resumable: false },
  { status: "completed" },
  { status: "stopped" },
  { status: "future-state" }
];

test("Draft confirmation explains no automatic Send and manual completion before Resume", () => {
  const run = { status: "paused", pauseReason: "draft-ready", resumable: true, outbox: null };
  const before = structuredClone(run);
  const ux = projectRunUx({ run, hasTarget: true, targetReady: true, pageReady: true });
  assert.equal(ux.kind, "confirmation-required");
  assert.equal(ux.label, "確認が必要");
  assert.equal(ux.reason, "AIへの指示を入力欄へ入れました。自動送信はしていません。内容の確認を待っています。");
  assert.equal(ux.nextAction, "ChatGPTの入力欄を確認し、必要なら自分で送信してください。生成が終わり、次へ進めてよいことを確認してから「再開」を押してください。");
  assert.deepEqual(run, before);
});

test("primary status copy explains execution state without exposing Run jargon", () => {
  assert.equal(projectRunState(null).reason, "現在実行中の自動化はありません。");
  assert.equal(projectRunState({ status: "stopped" }).reason, "この実行は停止済みです。");
  assert.equal(projectRunState({ status: "future-state" }).reason, "保存された実行状態を判別できません。");

  for (const run of primaryStates) {
    const state = projectRunState(run);
    assert.doesNotMatch(`${state.reason} ${state.safetyLabel}`, /\bRun\b/i);
  }

  const stopped = completionOutcomeForRun({ run: { status: "stopped" } });
  assert.equal(stopped.text, "停止済み — 必要なら新しく開始できます。");
  assert.doesNotMatch(stopped.text, /\bRun\b/i);
});

test("initial Side Panel reason matches the idle projection before runtime hydration", () => {
  const initialReason = sidepanelHtml.match(/<p id="message" aria-live="polite">([^<]*)<\/p>/u)?.[1];
  const idleReason = projectRunState(null).reason;

  assert.equal(initialReason, idleReason);
  assert.doesNotMatch(initialReason ?? "", /\bRun\b/i);
});
