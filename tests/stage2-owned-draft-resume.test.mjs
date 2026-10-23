import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

import { createWorkflowHarness } from "./helpers/workflow-harness.mjs";

const runnerSource = fs.readFileSync(new URL("../src/content-runner.js", import.meta.url), "utf8");
const TEXT = "SYNTHETIC OWNED TEXT";

function workflow(repeat = 3) {
  return {
    schemaVersion: 1, id: "owned-text-resume", name: "Owned text resume", maxSends: repeat,
    steps: [{ id: "send", type: "prompt", delivery: "send", prompt: TEXT, repeat, delayAfterMs: 0 }]
  };
}

function fakeEventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      const group = listeners.get(type) ?? new Set();
      group.add(listener);
      listeners.set(type, group);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatch(type, properties = {}) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener({ type, ...properties });
    },
    listenerCount(type) { return listeners.get(type)?.size ?? 0; }
  };
}

// A real Navigation API event boundary, not a URL-only approximation. Returning
// to the exact old entry must not restore a revoked text ownership capability.
function installNavigation(harness) {
  const lifecycle = fakeEventTarget();
  const navigation = Object.assign(fakeEventTarget(), {
    currentEntry: { key: "entry-1", id: "entry-id-1", index: 0 }
  });
  Object.assign(harness.context, {
    navigation,
    addEventListener: lifecycle.addEventListener,
    removeEventListener: lifecycle.removeEventListener
  });
  harness.context.window = harness.context;
  return { navigation, lifecycle };
}

async function pausedOwnedText({ repeat = 3, navigation = true, options = {} } = {}) {
  let pauseArmed = true;
  let harness;
  harness = createWorkflowHarness({
    ...options,
    async onRunGet(info) {
      const { storedRun, page } = info;
      if (pauseArmed && storedRun?.phase === "prepared" && page.text) {
        pauseArmed = false;
        assert.equal((await harness.control("AIPM_PAUSE")).ok, true);
      }
      return options.onRunGet?.(info) ?? null;
    }
  });
  const lifetime = navigation ? installNavigation(harness) : null;
  await harness.ready();
  await harness.start(workflow(repeat));
  await harness.settle();
  assert.equal(pauseArmed, false);
  assert.equal(harness.page.clicks, 0);
  assert.equal(harness.stored().pauseReason, "user-pause");
  assert.equal(harness.stored().outbox, null);
  assert.equal(harness.page.text, TEXT, "Pause must leave the visible text untouched");
  return { harness, lifetime };
}

const writes = (harness) => harness.transcript.filter((entry) => entry.type === "write").length;

for (const repeat of [1, 3]) {
  test(`explicit Resume adopts untouched owned text and completes ${repeat} positions without rewriting it`, async () => {
    const { harness } = await pausedOwnedText({ repeat });
    assert.equal(writes(harness), 1);
    assert.equal((await harness.control("AIPM_RESUME")).ok, true);
    await harness.settle();

    assert.equal(harness.stored().status, "completed");
    assert.equal(harness.page.clicks, repeat);
    assert.equal(harness.stored().cursor.sendsCompleted, repeat);
    assert.equal(writes(harness), repeat, "adopting the first position adds no second write");
    const attempts = new Set(harness.saves().map((run) => run.outbox?.id).filter(Boolean));
    assert.equal(attempts.size, repeat + 1, "Resume prepares a fresh outbox instead of reviving the paused attempt");
    assert.equal(new Set(harness.clicks().map((entry) => entry.position)).size, repeat);
    assert.equal(harness.page.activeDeliveryTransactions, 0);
  });
}

for (const invalidation of ["trusted-edit", "trusted-edit-then-revert", "attachment", "route-away-back", "pagehide", "reinjection", "document-replaced"]) {
  test(`${invalidation} while paused revokes ownership without changing or sending the draft`, async () => {
    const { harness, lifetime } = await pausedOwnedText();
    if (invalidation === "trusted-edit") {
      harness.page.text = "SYNTHETIC USER DRAFT";
      harness.page.userMutationEpoch += 1;
    } else if (invalidation === "trusted-edit-then-revert") {
      harness.page.userMutationEpoch += 2;
    } else if (invalidation === "attachment") {
      harness.page.attachmentCount = 1;
    } else if (invalidation === "route-away-back") {
      const originalEntry = lifetime.navigation.currentEntry;
      const originalKey = harness.conversationKey();
      harness.setConversationKey("chatgpt:c:other");
      lifetime.navigation.currentEntry = { key: "entry-2", id: "entry-id-2", index: 1 };
      lifetime.navigation.dispatch("currententrychange", { from: originalEntry });
      harness.setConversationKey(originalKey);
      lifetime.navigation.currentEntry = originalEntry;
      lifetime.navigation.dispatch("currententrychange");
    } else if (invalidation === "pagehide") {
      lifetime.lifecycle.dispatch("pagehide", { persisted: true });
    } else if (invalidation === "reinjection") {
      vm.runInContext(runnerSource, harness.context, { filename: "content-runner-reinjected.js" });
    } else {
      harness.context.instanceId = "replacement-content-instance";
    }
    const draftBeforeResume = harness.page.text;
    const attachmentsBeforeResume = harness.page.attachmentCount;
    await harness.control("AIPM_RESUME");
    await harness.settle();

    assert.equal(harness.page.clicks, 0);
    assert.equal(writes(harness), 1);
    assert.equal(harness.page.text, draftBeforeResume);
    assert.equal(harness.page.attachmentCount, attachmentsBeforeResume);
    assert.notEqual(harness.stored().status, "completed");
  });
}

test("missing Navigation lifetime evidence preserves the paused draft and refuses ownership adoption", async () => {
  const { harness } = await pausedOwnedText({ navigation: false });
  await harness.control("AIPM_RESUME");
  await harness.settle();
  assert.equal(harness.page.clicks, 0);
  assert.equal(writes(harness), 1);
  assert.equal(harness.page.text, TEXT);
  assert.notEqual(harness.stored().status, "completed");
});

test("Stop revokes the owned text and a later Resume cannot send it", async () => {
  const { harness } = await pausedOwnedText();
  assert.equal((await harness.control("AIPM_STOP")).ok, true);
  assert.equal((await harness.control("AIPM_RESUME")).ok, false);
  await harness.settle();
  assert.equal(harness.stored().status, "stopped");
  assert.equal(harness.page.text, TEXT);
  assert.equal(harness.page.clicks, 0);
  assert.equal(writes(harness), 1);
});

test("submitted outbox cannot be adopted even if its visible text matches the old draft", async () => {
  const { harness } = await pausedOwnedText();
  harness.injectDurableRun((run) => ({
    ...run,
    phase: "waiting-ack",
    outbox: { id: "synthetic-submitted", state: "submitted", stepId: "send" }
  }));
  assert.equal((await harness.control("AIPM_RESUME")).ok, false);
  await harness.settle();
  assert.equal(harness.page.clicks, 0);
  assert.equal(writes(harness), 1);
  assert.equal(harness.page.text, TEXT);
});

test("owned text remains resumable after a long explicit Pause without inheriting an expired settlement clock", async () => {
  const { harness } = await pausedOwnedText({ repeat: 1 });
  harness.advance(5 * 60_000);
  assert.equal((await harness.control("AIPM_RESUME")).ok, true);
  await harness.settle();
  assert.equal(harness.stored().status, "completed");
  assert.equal(harness.page.clicks, 1);
  assert.equal(writes(harness), 1);
});

test("duplicate Resume requests cannot consume the owned text twice", async () => {
  const { harness } = await pausedOwnedText({ repeat: 1 });
  const results = await Promise.all([
    harness.control("AIPM_RESUME"),
    harness.control("AIPM_RESUME")
  ]);
  await harness.settle();
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(harness.stored().status, "completed");
  assert.equal(harness.page.clicks, 1);
  assert.equal(writes(harness), 1);
});

test("trusted editing across Resume persistence prevents adoption without overwriting the edit", async () => {
  let edited = false;
  const { harness } = await pausedOwnedText({
    options: {
      onRunSet({ message, page }) {
        if (message.runTransition === "resume") {
          edited = true;
          page.text = "SYNTHETIC RESUME RACE EDIT";
          page.userMutationEpoch += 1;
        }
        return null;
      }
    }
  });
  await harness.control("AIPM_RESUME");
  await harness.settle();
  assert.equal(edited, true);
  assert.equal(harness.page.clicks, 0);
  assert.equal(writes(harness), 1);
  assert.equal(harness.page.text, "SYNTHETIC RESUME RACE EDIT");
});

test("a changed executable workflow cannot inherit the paused text capability", async () => {
  const { harness } = await pausedOwnedText();
  harness.injectDurableRun((run) => ({
    ...run,
    workflow: { ...run.workflow, steps: [{ ...run.workflow.steps[0], prompt: "DIFFERENT SYNTHETIC TEXT" }] }
  }));
  await harness.control("AIPM_RESUME");
  await harness.settle();
  assert.equal(harness.page.clicks, 0);
  assert.equal(writes(harness), 1);
  assert.equal(harness.page.text, TEXT);
});

for (const boundary of ["resume-persistence", "submitting-persistence"]) {
  test(`navigation during ${boundary} keeps revoked ownership from the final Send click`, async () => {
    let navigation = null;
    let resumed = false;
    let navigated = false;
    const { harness, lifetime } = await pausedOwnedText({
      options: {
        onRunSet({ message }) {
          if (message.runTransition === "resume") resumed = true;
          const matches = boundary === "resume-persistence"
            ? message.runTransition === "resume"
            : resumed && message.run?.phase === "submitting";
          if (navigation && matches && !navigated) {
            navigated = true;
            // Even a navigation attempt that leaves the same entry must revoke.
            navigation.dispatch("navigate");
          }
          return null;
        }
      }
    });
    navigation = lifetime.navigation;
    await harness.control("AIPM_RESUME");
    await harness.settle();
    assert.equal(navigated, true);
    assert.equal(harness.page.clicks, 0);
    assert.equal(writes(harness), 1);
    assert.equal(harness.page.text, TEXT);
  });
}

test("automatic execution without an explicit Resume grant cannot adopt paused text", async () => {
  const { harness } = await pausedOwnedText({ repeat: 1 });
  const run = harness.injectDurableRun((value) => ({ ...value, status: "running", pauseReason: null }));
  harness.context.localRunnerToken += 1;
  await harness.context.executeRun(run, harness.context.localRunnerToken);
  await harness.settle();
  assert.equal(harness.page.clicks, 0);
  assert.equal(writes(harness), 1);
  assert.equal(harness.page.text, TEXT);
  assert.equal(harness.stored().pauseReason, "draft_present");
});

for (const failure of ["save-failure", "state-conflict"]) {
  test(`a Pause ${failure} discards the uncommitted owned text capability`, async () => {
    let pauseArmed = true;
    let pauseSaveRejected = false;
    let harness;
    harness = createWorkflowHarness({
      async onRunGet({ storedRun, page }) {
        if (pauseArmed && storedRun?.phase === "prepared" && page.text) {
          pauseArmed = false;
          assert.equal((await harness.control("AIPM_PAUSE")).ok, true);
        }
        return null;
      },
      onRunSet({ message }) {
        if (message.runTransition === "pause" && message.run?.pauseReason === "user-pause") {
          pauseSaveRejected = true;
          return {
            ok: false,
            error: "Synthetic Pause persistence rejection",
            ...(failure === "state-conflict" ? { errorCode: "RUN_STATE_CONFLICT" } : {})
          };
        }
        return null;
      }
    });
    const { navigation, lifecycle } = installNavigation(harness);
    await harness.ready();
    await harness.start(workflow(1));
    await harness.settle();

    assert.equal(pauseArmed, false);
    assert.equal(pauseSaveRejected, true);
    assert.equal(harness.context.pausedPromptReceipt, null);
    assert.equal(harness.page.activeDeliveryTransactions, 0);
    assert.equal(navigation.listenerCount("navigate"), 0);
    assert.equal(navigation.listenerCount("currententrychange"), 0);
    assert.equal(lifecycle.listenerCount("pagehide"), 0);
    assert.equal(harness.page.clicks, 0);
    assert.equal(writes(harness), 1);
    assert.equal(harness.page.text, TEXT);
    assert.equal((await harness.control("AIPM_RESUME")).ok, false);
    await harness.settle();
    assert.equal(harness.page.clicks, 0);
  });
}
