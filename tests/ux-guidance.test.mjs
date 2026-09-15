import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildAipmFlowMetaPrompt } from "../src/flow-authoring.js";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const withoutHtmlComments = (source) => source.replace(/<!--[\s\S]*?-->/gu, "");
const html = read("src/sidepanel.html");
/* Phase 3 moved the explanation only sections and the AI authoring helper to
   the Workspace. The contracts below still have to hold - on that surface. */
const workspaceHtml = read("src/workspace.html");
const sidepanel = read("src/sidepanel.js");
const css = read("src/sidepanel.css");
const helper = read("src/ux-guidance.js");
const workflow = read("src/workflow.js");
const manifest = JSON.parse(read("manifest.json"));
const metaPrompt = buildAipmFlowMetaPrompt("レビュー後に3回改善する");

test("beginner-facing controls use plain Japanese wording", () => {
  const beginnerFacingSource = `${withoutHtmlComments(html)}\n${sidepanel}\n${withoutHtmlComments(workspaceHtml)}`;
  for (const text of [
    "実行コントロール",
    "クイック",
    "ワークスペース",
    "AIへの指示",
    "繰り返し回数",
    "待機",
    "指定時刻まで待つ",
    "確認ポイント",
    "入力だけして確認",
    "スリープ防止"
  ]) {
    assert.match(beginnerFacingSource, new RegExp(text));
  }

  assert.doesNotMatch(html, /class="tabs"/);
  assert.doesNotMatch(html, />Block Workflow</);
  assert.doesNotMatch(sidepanel, /return "Wait Until"|return "Delay"|return "Checkpoint"|Prompt · Draft|Prompt · Send/);
  assert.match(sidepanel, /手順 \$\{blockIndex\}\/\$\{blockTotal\} · 送信/);
});

test("AI authoring helper explains the output-blind bounded workflow contract", () => {
  for (const text of [
    "AIに自動化の手順を作ってもらう",
    "AIの回答本文を読み取り・保存・解析しません",
    "回答内容による条件分岐、回答の引用・抽出・成功判定、回答を変数として次のPromptへ差し込む処理はできません",
    "wait 30s",
    "wait until \"2026-08-25T09:00:00+09:00\"",
    "checkpoint",
    "最大50回",
    "前回までの会話を踏まえて",
    "再送せずFail-Closed停止します",
    "自動実行する対象はPC版ChatGPT（chatgpt.com）のみです",
    "ClaudeやGeminiなどはFlow案の作成には使えますが、AIPMの自動実行先にはなりません",
    "文脈の内容や保持範囲を確認・保証しません"
  ]) {
    assert.ok(`${workspaceHtml}\n${metaPrompt}`.includes(text), `missing helper contract text: ${text}`);
  }

  assert.match(workspaceHtml, /id="aiFlowGoal"/);
  assert.doesNotMatch(html, /id="aiFlowGoal"/);
  assert.match(helper, /buildAipmFlowMetaPrompt/);
  assert.match(helper, /navigator\.clipboard\?\.writeText/);
  assert.match(helper, /Ctrl\+C/);
  assert.doesNotMatch(helper, /fetch\(|XMLHttpRequest|sendBeacon|chrome\.runtime\.sendMessage/);
});

test("AI Flow meta-prompt is local, goal-aware and explicitly bounded", () => {
  assert.match(metaPrompt, /レビュー後に3回改善する/);
  assert.match(metaPrompt, /AIPM Flow v1\.1/);
  assert.match(metaPrompt, /64KiB/);
  assert.match(metaPrompt, /repeatの入れ子は3段/);
  assert.match(metaPrompt, /lateは pause \/ run \/ skip/);
  assert.doesNotMatch(metaPrompt, /API key|assistant outputを取得/);
});

test("long-running guidance distinguishes display off, sleep, hibernate, wake limits and lid-close setup", () => {
  for (const text of [
    "PC本体が起動状態のままなら、画面だけが消灯しても実行できます",
    "実行中の自動スリープを防ぎます",
    "すでにスリープ中のPCを起こす機能ではありません",
    "スリープ・休止状態・シャットダウン",
    "カバーを閉じたときの動作",
    "何もしない",
    "発熱"
  ]) {
    assert.ok(workspaceHtml.includes(text), `missing unattended-use guidance: ${text}`);
  }
});

test("browser restart guidance matches startup quarantine and schedule clearing", () => {
  assert.match(workspaceHtml, /Chrome \/ Edgeを完全終了した場合/);
  assert.match(workspaceHtml, /次回起動時に自動継続せず/);
  assert.match(workspaceHtml, /指定時刻の予定も解除されます/);
  assert.doesNotMatch(`${html}\n${workspaceHtml}`, /ブラウザを閉じていた場合、次回起動時に遅延として扱われます/);
});

test("run controls stay reachable and keep status plus next action together", () => {
  assert.ok(html.indexOf('id="runCard"') < html.indexOf('id="savedAutomation"'), "run controls must precede the saved editor summary");
  assert.ok(html.indexOf('id="start"') < html.indexOf('id="runCard"'), "idle status follows input and Start; active DOM ordering is browser-tested");
  assert.match(css, /\.run-card\[data-active="true"\]\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;/s);
  assert.match(html, /id="statusBadge"[^>]*>待機中</);
  assert.match(html, /id="nextAction"[^>]*aria-live="polite"/);
  assert.match(sidepanel, /el\.runCard\.dataset\.state = statusUx\.kind/);
  assert.match(sidepanel, /const startSource = await readStartSourceForTab\(intentTabId, \{ expectedEntry \}\)/);
  assert.match(sidepanel, /const startDisabled = [^;]*\|\| flowInvalid/);
  assert.match(sidepanel, /el\.start\.disabled = startDisabled/);
  assert.match(sidepanel, /el\.resume\.disabled = !canResumePausedRun\(run\) \|\| !targetReady \|\| payload\?\.pageReady !== true \|\|[\s\S]*?Boolean\(payload\?\.blocker\) \|\| runControlIntentInFlight/);
});

test("UX work does not broaden extension permissions or supported workflow primitives", () => {
  assert.deepEqual([...manifest.permissions].sort(), ["alarms", "power", "scripting", "sidePanel", "storage"].sort());
  assert.deepEqual(manifest.host_permissions, ["https://chatgpt.com/*"]);
  assert.deepEqual(manifest.content_scripts[0].matches, ["https://chatgpt.com/*"]);
  assert.match(workflow, /MAX_SENDS_PER_RUN = 50/);
  assert.match(workflow, /STEP_TYPES = \["prompt", "delay", "wait-until", "checkpoint"\]/);
});
