import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createWorkflowHarness } from "./helpers/workflow-harness.mjs";

import {
  blockerMessage,
  canResumePausedRun,
  canStartRun,
  completionOutcomeForRun,
  displayDeliveredSendCount,
  nextActionForRun,
  projectConnectionState,
  projectRunState,
  projectRunUx
} from "../src/run-ux.js";

for (const [code, detail] of [
  ["generation_timeout", /生成完了/],
  ["composer_not_ready", /次の入力/],
  ["document_identity_unconfirmed", /対象ページ/],
  ["conversation_changed", /対象の会話/],
  ["lease_conflict", /安全/],
  ["submission_ambiguous", /安全/]
]) {
  test(`confirmed delivery remains explicit in fail-closed UX: ${code}`, () => {
    const run = {
      status: "paused", phase: "ambiguous", resumable: false,
      pauseReason: code, lastErrorCode: code,
      cursor: { sendsCompleted: 2 }, outbox: { state: "confirmed" }
    };
    const before = structuredClone(run);
    const projection = projectRunUx({ run });
    assert.equal(projection.kind, "fail-closed");
    assert.match(projection.reason, /送信は確認済み/);
    assert.match(projection.reason, /同じ指示は自動再送しません/);
    assert.match(projection.reason, detail);
    assert.doesNotMatch(projection.reason, /送信(?:状態|結果)を一意に/);
    assert.equal(canResumePausedRun(run), false);
    assert.equal(displayDeliveredSendCount(run), 3);
    assert.deepEqual(run, before);
  });
}

test("confirmed generation timeout projects the actual durable runner result without retrying", async () => {
  const harness = createWorkflowHarness({ generationMs: 5_000 });
  harness.context.GENERATION_TIMEOUT_MS = 1_000;
  await harness.ready();
  await harness.start({
    schemaVersion: 1, id: "ux-confirmed-timeout", name: "Confirmed timeout", maxSends: 2,
    steps: [{ id: "prompt", type: "prompt", delivery: "send", prompt: "TEST", repeat: 2, delayAfterMs: 0 }]
  });
  await harness.settle();
  const run = harness.stored();
  assert.equal(run.lastErrorCode, "generation_timeout");
  assert.equal(run.outbox.state, "confirmed");
  assert.equal(harness.page.clicks, 1);
  assert.match(projectRunState(run).reason, /送信は確認済みですが、生成完了を確認できないため停止しました/);
  assert.match(projectRunState(run).reason, /同じ指示は自動再送しません/);
  const response = await harness.control("AIPM_RESUME");
  await harness.settle();
  assert.equal(response.ok, false);
  assert.equal(harness.page.clicks, 1);
  assert.equal(harness.stored().outbox.state, "confirmed");
});

for (const state of ["prepared", "submitted", "future-unknown"]) {
  test(`unconfirmed ${state} delivery is never presented as confirmed`, () => {
    const run = { status: "paused", resumable: false, pauseReason: "submission_ambiguous", outbox: { state } };
    assert.match(projectRunState(run).reason, /送信結果を一意に確認できない/);
    assert.doesNotMatch(projectRunState(run).reason, /送信は確認済み/);
  });
}

test("completion outcomes distinguish terminal success, human confirmation and fail-closed pause", () => {
  assert.equal(completionOutcomeForRun({ run: { status: "completed" } }).kind, "completed");
  assert.equal(completionOutcomeForRun({
    run: { status: "paused", pauseReason: "manual-checkpoint", resumable: true }
  }).kind, "confirmation");
  assert.equal(completionOutcomeForRun({
    run: {
      status: "paused",
      phase: "new-chat-confirmation-required",
      pauseReason: "new-chat-confirmation-required",
      lastErrorCode: "new-chat-confirmation-required",
      resumable: false
    }
  }).kind, "confirmation");
  assert.equal(completionOutcomeForRun({
    run: { status: "paused", pauseReason: "submission_ambiguous", resumable: false }
  }).kind, "fail-closed");
});

test("Stop-time presentation includes one confirmed outbox without mutating cursor authority", () => {
  const run = {
    status: "stopped",
    cursor: { sendsCompleted: 2 },
    outbox: { state: "confirmed" }
  };
  assert.equal(displayDeliveredSendCount(run), 3);
  assert.equal(run.cursor.sendsCompleted, 2);
});

test("presentation count ignores prepared and malformed outbox state", () => {
  assert.equal(displayDeliveredSendCount({ cursor: { sendsCompleted: 2 }, outbox: { state: "prepared" } }), 2);
  assert.equal(displayDeliveredSendCount({ cursor: { sendsCompleted: Number.NaN }, outbox: { state: "confirmed" } }), 1);
});

test("content status pill uses delivered presentation count without changing cursor authority", () => {
  const source = fs.readFileSync(new URL("../src/content-controller.js", import.meta.url), "utf8");
  const helper = source.match(/function displayDeliveredSendCount\(run\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(helper, "content-side delivered-count helper must remain present");
  const run = {
    status: "running",
    cursor: { sendsCompleted: 2 },
    outbox: { state: "confirmed" }
  };
  const displayed = vm.runInNewContext(`(${helper})(${JSON.stringify(run)})`);
  assert.equal(displayed, 3);
  assert.equal(run.cursor.sendsCompleted, 2);
  assert.match(source, /const completed = displayDeliveredSendCount\(run\);/);
  assert.match(source, /cursor remains the durable budget\/runtime authority/);
});

const readyContext = {
  hasTarget: true,
  targetReady: true,
  pageReady: true,
  blocker: null
};

test("pure Run projection exposes the full human status taxonomy", () => {
  const examples = [
    [null, "idle", "待機中"],
    [{ status: "running" }, "running", "実行中"],
    [{ status: "paused", pauseReason: "user-pause", resumable: true }, "user-paused", "一時停止中"],
    [{ status: "paused", pauseReason: "manual-checkpoint", resumable: true }, "confirmation-required", "確認が必要"],
    [{ status: "paused", pauseReason: "submission_ambiguous", resumable: false }, "fail-closed", "安全のため停止"],
    [{ status: "completed" }, "completed", "完了"],
    [{ status: "stopped" }, "stopped", "停止済み"],
    [{ status: "future-state" }, "unknown", "状態不明"]
  ];
  for (const [run, kind, label] of examples) {
    const projected = projectRunState(run);
    assert.equal(projected.kind, kind);
    assert.equal(projected.label, label);
  }
});

test("pause reasons produce human reasons and never surface raw technical text", () => {
  const manual = projectRunState({ status: "paused", pauseReason: "manual-checkpoint", resumable: true });
  assert.match(manual.reason, /確認ポイント/);
  const newChat = projectRunState({
    status: "paused",
    phase: "new-chat-confirmation-required",
    pauseReason: "new-chat-confirmation-required",
    resumable: false
  });
  assert.match(newChat.reason, /新しい会話/);
  const failClosed = projectRunState({
    status: "paused",
    pauseReason: "document_identity_unconfirmed",
    lastErrorMessage: "RAW_INTERNAL_STACK user secret",
    resumable: false
  });
  assert.match(failClosed.reason, /送信準備時と同じページ/);
  assert.doesNotMatch(failClosed.reason, /document|identity/i);
  assert.doesNotMatch(failClosed.reason, /RAW_INTERNAL_STACK|user secret/);
});

test("Run state and connection observation are separate axes", () => {
  const ux = projectRunUx({
    run: { status: "running" },
    hasTarget: true,
    targetReady: false,
    pageReady: false
  });
  assert.equal(ux.kind, "running");
  assert.equal(ux.label, "実行中");
  assert.equal(ux.connection.kind, "unknown");
  assert.match(ux.connection.label, /現在状態を確認できません/);
  assert.doesNotMatch(ux.connection.label, /停止/);
  assert.match(ux.nextAction, /再読み込み/);
  assert.doesNotMatch(ux.nextAction, /^次の操作:/);

  assert.equal(projectConnectionState(readyContext).kind, "available");
  assert.equal(projectConnectionState({ ...readyContext, blocker: "captcha" }).kind, "blocked");
});

test("Completed and stopped remain distinct outcomes", () => {
  assert.notEqual(projectRunState({ status: "completed" }).label, projectRunState({ status: "stopped" }).label);
  assert.equal(completionOutcomeForRun({ run: { status: "completed" } }).kind, "completed");
  assert.equal(completionOutcomeForRun({ run: { status: "stopped" } }).kind, "stopped");
});

test("Start requires a ready target, a ready page, and no blocker", () => {
  assert.equal(canStartRun(readyContext), true);
  assert.equal(canStartRun({ ...readyContext, targetReady: false }), false);
  assert.equal(canStartRun({ ...readyContext, pageReady: false }), false);
  assert.equal(canStartRun({ ...readyContext, blocker: "captcha" }), false);
  assert.equal(canStartRun(), false);
});

test("Side Panel projection preserves Run state when connection needs attention", () => {
  const examples = [
    [{ status: "running" }, "running", "実行中"],
    [{ status: "paused", pauseReason: "user-pause" }, "user-paused", "一時停止中"],
    [{ status: "paused", pauseReason: "manual-checkpoint" }, "confirmation-required", "確認が必要"]
  ];
  for (const [run, kind, label] of examples) {
    const ready = projectRunUx({ ...readyContext, run });
    assert.equal(ready.kind, kind);
    assert.equal(ready.label, label);
    assert.equal(ready.connection.kind, "available");

    const blocked = projectRunUx({ ...readyContext, blocker: "captcha", run });
    assert.equal(blocked.kind, kind);
    assert.equal(blocked.label, label);
    assert.equal(blocked.connection.kind, "blocked");
  }
});

test("only the explicit New Chat confirmation bypasses the generic non-resumable UI lock", () => {
  assert.equal(canResumePausedRun({
    status: "paused",
    phase: "new-chat-confirmation-required",
    pauseReason: "new-chat-confirmation-required",
    resumable: false
  }), true);
  assert.equal(canResumePausedRun({
    status: "paused",
    phase: "ambiguous",
    pauseReason: "new-chat-confirmation-required",
    resumable: false
  }), false);
  assert.equal(canResumePausedRun({
    status: "paused",
    phase: "ambiguous",
    pauseReason: "submission_ambiguous",
    resumable: false
  }), false);
  assert.equal(canResumePausedRun({
    status: "paused",
    pauseReason: "max_sends",
    lastErrorCode: "max_sends",
    resumable: true
  }), false);
  assert.equal(canResumePausedRun({ status: "running", resumable: true }), false);
});

test("C3: unfinished outbox states never present generic Resume authority", () => {
  for (const state of ["prepared", "submitted", "confirmed", "future-unknown"]) {
    const run = {
      status: "paused",
      phase: state,
      pauseReason: "user-pause",
      resumable: true,
      outbox: { state }
    };
    assert.equal(canResumePausedRun(run), false, state);
    assert.equal(projectRunState(run).kind, "fail-closed", state);
    assert.equal(completionOutcomeForRun({ ...readyContext, run }).kind, "fail-closed", state);
    assert.match(nextActionForRun({ ...readyContext, run }), /「停止」を押してください/, state);
    assert.doesNotMatch(nextActionForRun({ ...readyContext, run }), /「再開」/, state);
  }
});

test("C3: resumable pauses without an outbox retain their existing UI paths", () => {
  for (const pauseReason of ["user-pause", "manual-checkpoint"]) {
    const run = { status: "paused", pauseReason, resumable: true, outbox: null };
    assert.equal(canResumePausedRun(run), true, pauseReason);
    assert.match(nextActionForRun({ ...readyContext, run }), /「再開」/, pauseReason);
  }
});

test("C3: explicit New Chat confirmation remains the only unfinished-outbox exception", () => {
  const run = {
    status: "paused",
    phase: "new-chat-confirmation-required",
    pauseReason: "new-chat-confirmation-required",
    resumable: false,
    outbox: { state: "submitted" }
  };
  assert.equal(canResumePausedRun(run), true);
  assert.equal(completionOutcomeForRun({ ...readyContext, run }).kind, "confirmation");
  assert.match(nextActionForRun({ ...readyContext, run }), /同じChatGPTタブで、作成された会話と最初の指示が1回だけ送られていることを確認/);
  assert.match(nextActionForRun({ ...readyContext, run }), /「再開」/);
});

test("C3: runtime unfinished-outbox guard remains authoritative against stale UI", () => {
  const source = fs.readFileSync(new URL("../src/content-controller.js", import.meta.url), "utf8");
  const resumeBody = source.match(/async function resumeRun[\s\S]*?async function pauseCurrentRun/)?.[0];
  assert.ok(resumeBody);
  assert.match(resumeBody, /if \(hasUnfinishedOutbox\(run\)\) \{/);
  assert.match(resumeBody, /markDeliveryReviewRequired\(run\);/);
  assert.match(resumeBody, /await saveActiveRun\(run\);/);
});

test("attention and error states provide concrete next actions without exposing unknown codes", () => {
  const nonResumable = nextActionForRun({
    ...readyContext,
    run: { status: "paused", pauseReason: "submission_ambiguous", resumable: false }
  });
  assert.match(nonResumable, /「停止」を押してください/);
  assert.match(nonResumable, /自動再送されません/);
  assert.equal(projectRunState({
    status: "paused", pauseReason: "user-pause", resumable: false
  }).kind, "fail-closed");
  const blockedNonResumable = nextActionForRun({
    ...readyContext,
    blocker: "captcha",
    run: { status: "paused", pauseReason: "submission_ambiguous", resumable: false }
  });
  assert.match(blockedNonResumable, /「停止」を押してください/);
  assert.doesNotMatch(blockedNonResumable, /「再開」を押してください/);

  const newChat = nextActionForRun({
    ...readyContext,
    run: {
      status: "paused",
      phase: "new-chat-confirmation-required",
      pauseReason: "new-chat-confirmation-required",
      resumable: false
    }
  });
  assert.match(newChat, /同じChatGPTタブで、作成された会話と最初の指示が1回だけ送られていることを確認/);
  assert.match(newChat, /「再開」を押してください/);

  assert.equal(blockerMessage("login-required"), "ChatGPTへのログインが必要なため停止しています。");
  assert.equal(blockerMessage("unexpected-internal-code"), "ChatGPT側で安全停止の対象を検出しました。");
  assert.doesNotMatch(blockerMessage("unexpected-internal-code"), /unexpected-internal-code/);
});

test("blocker guidance only offers controls available for the current Run state", () => {
  const pausedResumable = nextActionForRun({
    ...readyContext,
    blocker: "login-required",
    run: { status: "paused", pauseReason: "login_required", resumable: true }
  });
  assert.match(pausedResumable, /「再開」を押してください/);

  const pausedNonResumable = nextActionForRun({
    ...readyContext,
    blocker: "captcha",
    run: { status: "paused", pauseReason: "submission_ambiguous", resumable: false }
  });
  assert.match(pausedNonResumable, /「停止」を押してください/);
  assert.doesNotMatch(pausedNonResumable, /「再開」を押してください/);

  const running = nextActionForRun({
    ...readyContext,
    blocker: "service-error",
    run: { status: "running" }
  });
  assert.match(running, /「停止」を押してください/);
  assert.doesNotMatch(running, /「再開」を押してください/);

  const beforeStart = nextActionForRun({ ...readyContext, blocker: "login-required", run: null });
  assert.match(beforeStart, /「更新」を押してください/);
  assert.match(beforeStart, /接続状態と保存済みの実行内容を確認し、「開始」が使える状態になったら押してください/);
  assert.doesNotMatch(beforeStart, /「再開」を押してください/);
});

test("connection failures lead to a stable reload-and-refresh action", () => {
  assert.equal(
    nextActionForRun({ ...readyContext, targetReady: false }),
    "次の操作: 選択中のChatGPTタブを再読み込みし、上の「更新」を押してください。"
  );
  assert.equal(
    nextActionForRun({ ...readyContext, hasTarget: false }),
    "次の操作: chatgpt.comを開き、上の「更新」を押してください。"
  );
});

/*
  An unfinished outbox says a send was in flight. It does not say which check failed.
  Every fail-closed carrying one used to render the same sentence, so an identity or
  observation failure looked exactly like an unconfirmed send — which is precisely the
  distinction a live investigation needs. Naming the recorded cause is presentation only:
  Resume authority is unchanged and still refused for every unfinished outbox.
*/
test("a fail-closed with an outbox names the cause the durable record actually holds", () => {
  const withOutbox = (lastErrorCode) => ({
    status: "paused",
    phase: "ambiguous",
    resumable: false,
    pauseReason: lastErrorCode,
    lastErrorCode,
    outbox: { state: "submitted" }
  });

  assert.match(
    projectRunState(withOutbox("submission_ambiguous")).reason,
    /自動再送せず停止/,
    "an unconfirmed send must say so"
  );
  assert.match(
    projectRunState(withOutbox("document_identity_unconfirmed")).reason,
    /送信準備時と同じページであることを確認できない/,
    "an identity failure must not be reported as an unconfirmed send"
  );
  assert.match(
    projectRunState(withOutbox("conversation_changed")).reason,
    /同じ会話か確認できない|別の会話へ送らず/,
    "a conversation change must not be reported as an unconfirmed send"
  );

  // A cause with no dedicated sentence still keeps the duplicate-send assurance.
  assert.match(
    projectRunState(withOutbox("lease_conflict")).reason,
    /重複送信を避けて/
  );

  // Presentation changed; authority did not.
  for (const code of ["submission_ambiguous", "document_identity_unconfirmed", "lease_conflict"]) {
    assert.equal(canResumePausedRun(withOutbox(code)), false, `${code} must never present Resume`);
    assert.equal(projectRunState(withOutbox(code)).kind, "fail-closed");
  }
});
