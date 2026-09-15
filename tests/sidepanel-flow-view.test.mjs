import assert from "node:assert/strict";
import test from "node:test";

import { buildAipmFlowMetaPrompt } from "../src/flow-authoring.js";
import { compileAipmFlow } from "../src/flow-compile.js";
import { buildExecutionPlan } from "../src/execution-plan.js";
import { initializeFlowGuide, renderFlowPlanSteps } from "../src/sidepanel-flow-view.js";

function fixtureDocument() {
  const document = {
    createElement(tagName) {
      const listeners = new Map();
      return {
        tagName: tagName.toUpperCase(),
        ownerDocument: document,
        children: [],
        textContent: "",
        value: "",
        open: false,
        focused: false,
        selected: false,
        append(...nodes) { this.children.push(...nodes); },
        replaceChildren(...nodes) { this.children = nodes; },
        focus() { this.focused = true; },
        select() { this.selected = true; },
        addEventListener(type, handler) {
          if (!listeners.has(type)) listeners.set(type, []);
          listeners.get(type).push(handler);
        },
        async dispatch(type) {
          for (const handler of listeners.get(type) ?? []) {
            await handler({ preventDefault() {} });
          }
        }
      };
    }
  };
  return document;
}

function guideElements() {
  const document = fixtureDocument();
  return {
    goal: document.createElement("textarea"),
    guideText: document.createElement("textarea"),
    guideDetails: document.createElement("details"),
    copyButton: document.createElement("button"),
    copyStatus: document.createElement("p")
  };
}

function localOnlyEnvironment(context, clipboard) {
  context.mock.method(globalThis, "fetch", () => { throw new Error("unexpected network access"); });
  const descriptors = new Map(["navigator", "chrome"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard } });
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    get() { throw new Error("unexpected extension runtime access"); }
  });
  context.after(() => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
}

test("guide initialization and goal editing remain local; explicit clicks copy the exact shared guide", async (context) => {
  const copies = [];
  localOnlyEnvironment(context, { async writeText(text) { copies.push(text); } });
  const elements = guideElements();
  initializeFlowGuide(elements);
  assert.equal(elements.guideText.readOnly, true);
  assert.equal(elements.guideText.value, buildAipmFlowMetaPrompt());
  assert.equal(copies.length, 0);
  await elements.copyButton.dispatch("click");
  assert.deepEqual(copies, [buildAipmFlowMetaPrompt()]);
  assert.match(elements.copyStatus.textContent, /コピーしました/);

  elements.goal.value = "日本語の長い指示を3回改善する";
  await elements.goal.dispatch("input");
  assert.equal(elements.copyStatus.textContent, "");
  assert.equal(elements.guideText.value, buildAipmFlowMetaPrompt(elements.goal.value));
  assert.equal(copies.length, 1);
  await elements.copyButton.dispatch("click");
  assert.deepEqual(copies, [buildAipmFlowMetaPrompt(), buildAipmFlowMetaPrompt(elements.goal.value)]);
});

for (const unavailable of [false, true]) {
  test(`guide clipboard ${unavailable ? "unavailability" : "rejection"} exposes and selects the full text without losing the goal`, async (context) => {
    localOnlyEnvironment(context, unavailable ? undefined : { async writeText() { throw new Error("copy denied"); } });
    const elements = guideElements();
    elements.goal.value = "この目的を保持する";
    initializeFlowGuide(elements);
    const guide = elements.guideText.value;
    await elements.copyButton.dispatch("click");
    assert.equal(elements.goal.value, "この目的を保持する");
    assert.equal(elements.guideText.value, guide);
    assert.equal(elements.guideDetails.open, true);
    assert.equal(elements.guideText.focused, true);
    assert.equal(elements.guideText.selected, true);
    assert.match(elements.copyStatus.textContent, /全文を Ctrl\+C/);
  });
}

test("plan preview renders production-compiled step order, full prompt text, repeats and waiting policies without changing the plan", (context) => {
  localOnlyEnvironment(context, { writeText() { throw new Error("unexpected clipboard write"); } });
  const compiled = compileAipmFlow(`flow review {
    repeat 3 { send """<script>これはHTMLではなく指示本文</script>\n日本語の全文を保持""" }
    wait 500ms
    wait until "2030-01-02T03:04:05+09:00" late skip grace 10m
    checkpoint "利用者が確認する"
    send """最終指示"""
  }`).flows[0];
  const plan = buildExecutionPlan(compiled);
  const before = JSON.stringify(plan);
  const container = fixtureDocument().createElement("div");
  renderFlowPlanSteps(container, plan);
  assert.equal(container.children.length, 1);
  const list = container.children[0];
  assert.equal(list.tagName, "OL");
  assert.equal(list.children.length, plan.workflow.steps.length);
  const promptDetails = list.children[0].children[0];
  assert.equal(promptDetails.tagName, "DETAILS");
  assert.equal(promptDetails.children[0].tagName, "SUMMARY");
  assert.equal(promptDetails.open, false, "full prompts are disclosed explicitly");
  assert.match(promptDetails.children[0].textContent, /^3回 · <script>これはHTMLではなく指示本文/);
  assert.equal(promptDetails.children[1].tagName, "PRE");
  assert.equal(promptDetails.children[1].textContent, plan.workflow.steps[0].prompt);
  assert.equal(promptDetails.children[1].children.length, 0);
  assert.match(list.children[1].textContent, /500ミリ秒待機/);
  assert.ok(list.children[2].textContent.includes(plan.workflow.steps[2].at));
  assert.match(list.children[2].textContent, /Z まで待機.*スキップ.*10分/);
  assert.match(list.children[3].textContent, /確認ポイント: 利用者が確認する/);
  assert.equal(list.children[4].children[0].children[1].textContent, "最終指示");
  assert.equal(JSON.stringify(plan), before);

  const partial = buildExecutionPlan(compiled, { mode: "step", start: "5" });
  renderFlowPlanSteps(container, partial);
  assert.equal(container.children[0].children.length, 1);
  assert.equal(container.children[0].children[0].children[0].children[1].textContent, "最終指示");
  renderFlowPlanSteps(container, null);
  assert.equal(container.children.length, 0);
});
