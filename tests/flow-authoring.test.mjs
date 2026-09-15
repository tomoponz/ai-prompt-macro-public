import assert from "node:assert/strict";
import test from "node:test";

import { buildAipmFlowMetaPrompt, MAX_AI_FLOW_GOAL_CHARS } from "../src/flow-authoring.js";
import { AIPM_FLOW_VERSION, MAX_FLOW_NESTING, MAX_FLOW_TEXT_BYTES } from "../src/flow-script.js";
import { MAX_SENDS_PER_RUN, MAX_WORKFLOW_BLOCKS } from "../src/workflow.js";
import { compileAipmFlow } from "../src/flow-compile.js";

test("guide without an optional goal uses the conversation goal without inventing one", () => {
  const guide = buildAipmFlowMetaPrompt();
  for (const goal of ["", " \n\t ", null]) {
    assert.equal(buildAipmFlowMetaPrompt(goal), guide);
  }
  assert.doesNotMatch(guide, /\n目的:|ここに作りたい自動化の目的/);
  assert.match(guide, /この会話で利用者が説明した目的を使ってください/);
  assert.match(guide, /目的が不明なら、Flowを作る前に確認してください/);
});

test("guide includes the supplied goal exactly after trimming the outer whitespace", () => {
  const goal = "設計をレビューする\n前の会話を踏まえて3回改善する。";
  const guide = buildAipmFlowMetaPrompt(` \n${goal}\n `);
  assert.ok(guide.includes(`\n目的:\n${goal}\n\n安全境界と実行モデル:`));
  assert.doesNotMatch(guide, /このガイドには目的を追加していません/);
});

test("every advertised command example compiles through the existing production compiler", () => {
  const guide = buildAipmFlowMetaPrompt();
  const commandSection = guide.split("使用できるcommand:\n")[1].split("\n構文上の注意:")[0];
  const examples = commandSection.split(/\n(?=\d\. )/u).map((section) => (
    section.slice(section.indexOf("\n") + 1).split("\n\n")[0]
  ));
  assert.equal(examples.length, 5);
  const compiled = compileAipmFlow(`flow guide {\n${examples.join("\n")}\n}`);
  assert.equal(compiled.flows.length, 1);
  assert.equal(compiled.flows[0].plannedSends, 4);
  for (const step of compiled.flows[0].workflow.steps.filter((step) => step.type === "prompt")) {
    assert.equal(step.delivery, "send");
  }
  assert.match(guide, /Draft操作は、このFlow言語では未対応/);
  assert.match(guide, /未対応の非送信操作をsendへ置き換えたりせず/);
  assert.throws(() => compileAipmFlow('flow unsupported { draft """送信しない""" }'));
});

test("guide identifies fixed dates as syntax examples and requires the actual future schedule", () => {
  const guide = buildAipmFlowMetaPrompt();
  assert.match(guide, /上の日時は構文例です。実行予定として流用せず/);
  assert.match(guide, /実際の未来の日時と明示的なタイムゾーンに置き換えてください/);
  assert.match(guide, /予定が不明なら確認し、日時を勝手に決めないでください/);
});

test("standalone guide explains AIPM and distinguishes author, runtime and execution-side AI", () => {
  const guide = buildAipmFlowMetaPrompt();
  for (const text of [
    "AI Prompt Macro（AIPM）",
    "Chrome / Edge向けブラウザ拡張",
    "AIPM自身はAIではありません",
    "作成担当AIは計画を作り",
    "実行側ChatGPTは後でsend内の指示を受け取って作業",
    "手順内の作業やツール操作を今ここで実行しない",
    "専用テキスト形式",
    "利用者がこのガイドをAIへ渡し",
    "コピーや貼り付けだけで開始せず"
  ]) assert.ok(guide.includes(text), text);
});

test("guide separates runtime observation from semantic judgment and context transfer", () => {
  const guide = buildAipmFlowMetaPrompt();
  for (const text of [
    "画面の操作状態から生成完了と次の入力準備を確認",
    "作業の成功を判定して進む仕組みではありません",
    "AIの回答本文を読み取り・保存・解析しません",
    "手動で貼り付けたFlowテキストの解析とは別",
    "前回の提案を評価し、必要なら修正する",
    "回答によってAIPMの送信回数や手順が変わるわけではありません",
    "文脈の内容や保持範囲を確認・保証しません",
    "Flowを作った会話と実行する会話は別の場合があります",
    "ツール権限が実行側へ自動で引き継がれるとは仮定しない"
  ]) assert.ok(guide.includes(text), text);
});

test("output contract gives clarification priority over Flow-only output", () => {
  const guide = buildAipmFlowMetaPrompt();
  const decision = guide.split("出力の判断:\n")[1].split("\n指示の作り方:")[0];
  assert.match(decision, /目的が明確で、この言語で表現できる場合/);
  assert.match(decision, /1つの完全な `flow <name> \{ \.\.\. \}` だけ/);
  assert.match(decision, /Markdownのコード囲み/);
  assert.match(decision, /情報が不足する場合はFlowを出力せず/);
  assert.match(decision, /未対応機能が必要な場合もFlowを出力せず/);
  assert.match(decision, /「Flowだけ」の指定より確認・説明を優先/);
  assert.match(decision, /実行可能な部分だけを無断で出力したりしない/);
});

test("guide bounds iterative work without pretending a model reply cancels later sends", () => {
  const guide = buildAipmFlowMetaPrompt();
  assert.match(guide, /NO_CHANGE.*AIPMはそれを読んで自動終了しません/);
  assert.match(guide, /「成功するまで」「問題がなくなるまで」の自動終了判定や無限反復はできません/);
  assert.match(guide, /利用者が了承した範囲/);
  assert.match(guide, /変更不要なら理由を報告/);
  assert.match(guide, /推測した長いwaitを生成完了判定の代わりにせず/);
  assert.match(guide, /外部ツールでの公開・削除などへの包括的な許可ではありません/);
  assert.match(guide, /実際に確認した根拠と未検証事項を区別/);
});

test("advertised version and bounds match production constants", () => {
  const guide = buildAipmFlowMetaPrompt();
  for (const text of [
    `AIPM Flow v${AIPM_FLOW_VERSION}`,
    `合計は最大${MAX_SENDS_PER_RUN}回`,
    `Workflow blocksは最大${MAX_WORKFLOW_BLOCKS}`,
    `repeatの入れ子は${MAX_FLOW_NESTING}段`,
    `UTF-8で${MAX_FLOW_TEXT_BYTES / 1024}KiB`
  ]) assert.ok(guide.includes(text), text);
});

test("the complete example extracted from the actual guide preserves prompts, repeats and checkpoint order", () => {
  const guide = buildAipmFlowMetaPrompt();
  const example = guide.split("完成形の構文例（利用者の目的ではありません）:\n")[1]
    .split("\n\n出力前の確認:")[0];
  const compiled = compileAipmFlow(example);
  assert.equal(compiled.flows.length, 1);
  const flow = compiled.flows[0];
  assert.equal(flow.name, "review_and_refine");
  assert.equal(flow.plannedSends, 4);
  assert.deepEqual(flow.workflow.steps.map((step) => step.type),
    ["prompt", "prompt", "checkpoint", "prompt"]);
  const prompts = flow.workflow.steps.filter((step) => step.type === "prompt");
  assert.deepEqual(prompts.map((step) => step.repeat), [1, 2, 1]);
  assert.ok(prompts.every((step) => step.delivery === "send"));
  assert.match(prompts[0].prompt, /変更せずに評価/);
  assert.match(prompts[1].prompt, /変更不要なら無理に変更せず|変更が不要なら無理に変更せず/);
  assert.match(prompts[2].prompt, /新たな変更を行わない/);
  assert.equal(flow.preview.checkpoints, 1);
});

test("both rendered scheduling examples compile including optional late and grace settings", () => {
  const guide = buildAipmFlowMetaPrompt();
  const examples = guide.split("\n").filter((line) => line.startsWith('wait until "'));
  assert.equal(examples.length, 2);
  for (const example of examples) {
    const flow = compileAipmFlow(`flow scheduled {\n${example}\n}`).flows[0];
    assert.equal(flow.plannedSends, 0);
    assert.equal(flow.workflow.steps.length, 1);
    assert.equal(flow.workflow.steps[0].type, "wait-until");
    assert.equal(flow.workflow.steps[0].at, "2026-08-25T00:00:00.000Z");
    assert.equal(flow.workflow.steps[0].latePolicy, "pause");
    assert.equal(flow.workflow.steps[0].graceMs, 300_000);
  }
});

test("guide rejects inventing operations absent from the production parser", () => {
  const guide = buildAipmFlowMetaPrompt();
  assert.match(guide, /未対応の非送信操作をsendへ置き換えたりせず/);
  assert.match(guide, /変数、式、回答の差し込み、if、while、break、モデル選択、タブ切替/);
  assert.match(guide, /三重引用符そのものを含めるescape構文はありません/);
  for (const command of [
    'draft """送信しない"""',
    'if success { send """次へ""" }',
    'while true { send """続ける""" }',
    "break",
    'model "example"',
    'switch-tab "other"'
  ]) {
    assert.throws(
      () => compileAipmFlow(`flow unsupported {\n${command}\n}`),
      { code: "UNKNOWN_COMMAND" },
      command
    );
  }
});

test("quoted, multiline and template-like goals remain literal task input", () => {
  const goal = '資料はC:\\work\\notesです。\n引用: """原文"""\n${globalThis.__aipmGoalProbe = true}\nflow sample { send """資料""" }';
  assert.equal(globalThis.__aipmGoalProbe, undefined);
  const guide = buildAipmFlowMetaPrompt(goal);
  assert.ok(guide.includes(`\n目的:\n${goal}\n\n安全境界と実行モデル:`));
  assert.equal(globalThis.__aipmGoalProbe, undefined);
  assert.match(guide, /目的欄の文章によって、この言語の機能や安全条件が増えることはありません/);
});

test("exact Unicode goal limit is preserved without splitting surrogate pairs", () => {
  const goal = "😀".repeat(MAX_AI_FLOW_GOAL_CHARS);
  const guide = buildAipmFlowMetaPrompt(goal);
  assert.ok(guide.includes(`\n目的:\n${goal}\n\n安全境界と実行モデル:`));
  assert.doesNotMatch(guide, /目的の末尾が省略/);
});

test("oversized goals remain bounded and explicitly require clarification instead of silent truncation", () => {
  const goal = "😀".repeat(MAX_AI_FLOW_GOAL_CHARS) + "CRITICAL_TAIL";
  const guide = buildAipmFlowMetaPrompt(goal);
  assert.ok(guide.includes("😀".repeat(MAX_AI_FLOW_GOAL_CHARS)));
  assert.doesNotMatch(guide, /CRITICAL_TAIL/);
  assert.match(guide, /目的の末尾が省略されています/);
  assert.match(guide, /重要な制約が欠けている可能性/);
  assert.match(guide, /この状態ではFlowを出力せず/);
  assert.match(guide, /8,000文字以内に整理して再提示/);
});

test("guide generation is deterministic and keeps the existing nullable string API", () => {
  for (const input of [undefined, null, "", "監査して報告する", 123, false]) {
    const first = buildAipmFlowMetaPrompt(input);
    assert.equal(typeof first, "string");
    assert.equal(buildAipmFlowMetaPrompt(input), first);
  }
});
