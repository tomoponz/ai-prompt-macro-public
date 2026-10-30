import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";

import { createWorkflowHarness, promptsSent } from "./helpers/workflow-harness.mjs";

// Exercises production runner/controller with modeled input and storage. The
// separate production-core DOM tests cover actual input-node preservation and
// attachment recognition; this file does not claim ChatGPT compatibility.
const MACRO = "SYNTHETIC NEXT INSTRUCTION";
const PREFIX = "SYNTHETIC EXISTING INPUT";
const writes = (h) => h.transcript.filter((entry) => entry.type === "write");
const runnerSource = fs.readFileSync(new URL("../src/content-runner.js", import.meta.url), "utf8");

function workflow(prompt = MACRO, repeat = 3) {
  return {
    schemaVersion: 1, id: "approved-input-lifecycle", name: "Approved initial input",
    maxSends: repeat,
    steps: [{ id: "send", type: "prompt", delivery: "send", prompt, repeat, delayAfterMs: 0 }]
  };
}

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      const group = listeners.get(type) ?? new Set();
      group.add(listener);
      listeners.set(type, group);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatch(type) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener({ type });
    }
  };
}

function installNavigation(harness) {
  const lifecycle = eventTarget();
  const navigation = Object.assign(eventTarget(), {
    currentEntry: { key: "approved-entry", id: "approved-entry-id", index: 0 }
  });
  Object.assign(harness.context, {
    navigation,
    addEventListener: lifecycle.addEventListener,
    removeEventListener: lifecycle.removeEventListener
  });
  harness.context.window = harness.context;
  return { navigation, lifecycle };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function reloadWithEmptyComposerAndNoLocalInput(h, lifecycle) {
  lifecycle.dispatch("pagehide");
  // The ordinary reload helper models durable recovery; actual reinjection also
  // discards the document-local append/paused-input capabilities. Exercise the
  // production initializers rather than granting the new invocation a fake receipt.
  const trackedExecute = h.context.executeRun;
  vm.runInContext(runnerSource, h.context, { filename: "content-runner-reloaded.js" });
  h.context.executeRun = trackedExecute;
  await h.reload();
  assert.equal(h.page.text, "");
}

async function start(harness, plan = workflow()) {
  await harness.ready();
  const response = await harness.start(plan);
  assert.equal(response.ok, true, response.error);
  await harness.settle();
}

function assertCompleted(harness, expectedPrompts) {
  assert.equal(harness.stored().status, "completed");
  assert.equal(harness.stored().cursor.sendsCompleted, expectedPrompts.length);
  assert.equal(harness.page.clicks, expectedPrompts.length);
  assert.deepEqual(promptsSent(harness), expectedPrompts);
  assert.equal(new Set(harness.clicks().map((entry) => `${entry.runId}:${entry.position}`)).size,
    expectedPrompts.length, "every logical position is sent once");
  assert.equal(harness.page.activeDeliveryTransactions, 0);
}

for (const prefix of [PREFIX, "@SYNTHETIC_PLUGIN arbitrary input", "日本語🚀e\u0301👩‍💻<&>\n", "   "]) {
  test(`initial ${JSON.stringify(prefix)} is appended once, preserved, and not repeated`, async () => {
    const h = createWorkflowHarness({ initialComposerText: prefix });
    installNavigation(h);
    await start(h);
    const first = `${prefix}${prefix.endsWith("\n") ? "" : "\n"}${MACRO}`;
    assertCompleted(h, [first, MACRO, MACRO]);
    assert.deepEqual(writes(h).map((entry) => entry.prompt), [first, MACRO, MACRO]);
    assert.equal(h.stored().workflow.steps[0].prompt, MACRO);
    // The approved existing input is an ephemeral capability, not Run metadata.
    if (prefix.trim()) {
      assert.equal(JSON.stringify(h.saves()).includes(prefix), false);
      assert.equal(JSON.stringify(h.diagnostics()).includes(prefix), false);
    }
  });
}

test("an ordinary empty composer retains short Repeat behavior", async () => {
  const h = createWorkflowHarness();
  await start(h);
  assertCompleted(h, [MACRO, MACRO, MACRO]);
});

test("retained initial Unicode plus a modeled long suffix conversion completes without prefix accumulation", async () => {
  const prefix = "SYNTHETIC INITIAL 日本語🚀";
  const prompt = "日本語🚀e\u0301👩‍💻<&>\n".repeat(6_000) + "終";
  const h = createWorkflowHarness({ initialComposerText: prefix, convertPasteToAttachment: true });
  installNavigation(h);
  await start(h, workflow(prompt));
  assertCompleted(h, [`${prefix}\n${prompt}`, prompt, prompt]);
  assert.equal(writes(h).length, 3);
  assert.equal(h.saves().some((run) => run.outbox?.deliveryMode === "paste-attachment"), true);
});

test("a conversion that erases the authorized initial prefix cannot be sent", async () => {
  const h = createWorkflowHarness({
    initialComposerText: PREFIX,
    convertPasteToAttachment: true,
    onWrite({ page }) { page.text = ""; }
  });
  installNavigation(h);
  await start(h);
  assert.equal(h.page.clicks, 0);
  assert.equal(writes(h).length, 1);
  assert.equal(h.page.attachmentCount, 1);
  assert.notEqual(h.stored().status, "completed");
});

test("initial file attachment is preserved and never authorized by the append permission", async () => {
  const h = createWorkflowHarness({ initialComposerText: PREFIX, initialAttachmentCount: 1 });
  installNavigation(h);
  await h.ready();
  await h.start(workflow());
  await h.settle();
  assert.equal(h.page.clicks, 0);
  assert.equal(writes(h).length, 0);
  assert.equal(h.page.text, PREFIX);
  assert.equal(h.page.attachmentCount, 1);
  assert.notEqual(h.stored()?.status, "completed");
});

test("a user edit after Start capture cannot be appended to or overwritten", async () => {
  const edited = "SYNTHETIC USER CHANGED DURING START";
  let editApplied = false;
  const h = createWorkflowHarness({
    initialComposerText: PREFIX,
    onSave({ run, page }) {
      if (!editApplied && run.status === "running" && !run.outbox) {
        editApplied = true;
        page.text = edited;
        page.userMutationEpoch += 1;
      }
    }
  });
  installNavigation(h);
  await start(h);
  assert.equal(editApplied, true);
  assert.equal(h.page.clicks, 0);
  assert.equal(writes(h).length, 0);
  assert.equal(h.page.text, edited);
  assert.notEqual(h.stored().status, "completed");
});

test("a new draft after first send is protected rather than implicitly authorized for repeat", async () => {
  const edited = "SYNTHETIC USER SECOND-POSITION DRAFT";
  let editApplied = false;
  const h = createWorkflowHarness({
    initialComposerText: PREFIX,
    onSave({ run, page }) {
      if (!editApplied && run.cursor.sendsCompleted === 1 && !run.outbox) {
        editApplied = true;
        page.text = edited;
        page.userMutationEpoch += 1;
      }
    }
  });
  installNavigation(h);
  await start(h);
  assert.equal(editApplied, true);
  assert.equal(h.page.clicks, 1);
  assert.equal(writes(h).length, 1);
  assert.equal(h.page.text, edited);
  assert.equal(h.stored().cursor.sendsCompleted, 1);
});

async function pauseCombinedInput() {
  let pauseRequested = false;
  let h;
  h = createWorkflowHarness({
    initialComposerText: PREFIX,
    async onSave({ run }) {
      if (!pauseRequested && run.phase === "prepared" && run.outbox?.deliveryMode === "text") {
        pauseRequested = true;
        assert.equal((await h.control("AIPM_PAUSE")).ok, true);
      }
    }
  });
  const lifetime = installNavigation(h);
  await start(h);
  assert.equal(pauseRequested, true, "Pause must reach the mode-save boundary before submitting");
  assert.equal(h.page.clicks, 0, "a committed pre-submitting Pause prevents the first click");
  assert.equal(h.page.text, `${PREFIX}\n${MACRO}`);
  assert.equal(h.stored().status, "paused");
  assert.equal(h.stored().cursor.sendsCompleted, 0);
  return { h, lifetime };
}

test("Pause before submitting and explicit Resume reuse the combined input without a second append", async () => {
  const { h } = await pauseCombinedInput();
  assert.equal(writes(h).length, 1);
  assert.equal((await h.control("AIPM_RESUME")).ok, true);
  await h.settle();
  assertCompleted(h, [`${PREFIX}\n${MACRO}`, MACRO, MACRO]);
  assert.equal(writes(h).length, 3, "Resume adopts the first write, rather than appending again");
});

test("concurrent Resume cannot consume the combined input capability twice", async () => {
  const { h } = await pauseCombinedInput();
  const results = await Promise.all([h.control("AIPM_RESUME"), h.control("AIPM_RESUME")]);
  await h.settle();
  assert.equal(results.filter((result) => result.ok).length, 1);
  assertCompleted(h, [`${PREFIX}\n${MACRO}`, MACRO, MACRO]);
  assert.equal(writes(h).length, 3);
});

test("Stop revokes the paused combined input without restoring or appending anything", async () => {
  const { h } = await pauseCombinedInput();
  assert.equal((await h.control("AIPM_STOP")).ok, true);
  assert.equal((await h.control("AIPM_RESUME")).ok, false);
  await h.settle();
  assert.equal(h.stored().status, "stopped");
  assert.equal(h.page.clicks, 0);
  assert.equal(writes(h).length, 1);
  assert.equal(h.page.text, `${PREFIX}\n${MACRO}`);
});

for (const interference of ["edit", "same-text-edit", "attachment", "navigation-away-back"]) {
  test(`${interference} while combined input is paused prevents adoption and preserves current input`, async () => {
    const { h, lifetime } = await pauseCombinedInput();
    if (interference === "edit") {
      h.page.text = "SYNTHETIC MANUAL REPLACEMENT";
      h.page.userMutationEpoch += 1;
    } else if (interference === "same-text-edit") {
      h.page.userMutationEpoch += 2;
    } else if (interference === "attachment") {
      h.page.attachmentCount = 1;
    } else {
      const entry = lifetime.navigation.currentEntry;
      lifetime.navigation.currentEntry = { key: "elsewhere", id: "elsewhere-id" };
      lifetime.navigation.dispatch("currententrychange");
      lifetime.navigation.currentEntry = entry;
      lifetime.navigation.dispatch("currententrychange");
    }
    const text = h.page.text;
    const attachments = h.page.attachmentCount;
    await h.control("AIPM_RESUME");
    await h.settle();
    assert.equal(h.page.clicks, 0);
    assert.equal(writes(h).length, 1);
    assert.equal(h.page.text, text);
    assert.equal(h.page.attachmentCount, attachments);
    assert.notEqual(h.stored().status, "completed");
  });
}

test("a provably unclicked Send timeout can Resume the unchanged full input exactly once", async () => {
  const h = createWorkflowHarness({ initialComposerText: PREFIX });
  installNavigation(h);
  await h.ready();
  const adapter = h.context.ChatGptAdapter;
  const button = adapter.findSendButton();
  button.disabled = true;
  await h.start(workflow());
  await h.settle();
  assert.equal(h.stored().lastErrorCode, "send_unavailable");
  assert.equal(h.page.clicks, 0);
  assert.equal(h.page.text, `${PREFIX}\n${MACRO}`);
  assert.equal(writes(h).length, 1);
  button.disabled = false;
  assert.equal((await h.control("AIPM_RESUME")).ok, true);
  await h.settle();
  assertCompleted(h, [`${PREFIX}\n${MACRO}`, MACRO, MACRO]);
  assert.equal(writes(h).length, 3);
});

test("a prepared failure before writing retains the initial capability for explicit Resume", async () => {
  const h = createWorkflowHarness({ initialComposerText: PREFIX });
  installNavigation(h);
  await h.ready();
  const adapter = h.context.ChatGptAdapter;
  const findComposer = adapter.findComposer;
  let missing = true;
  adapter.findComposer = () => missing && h.stored()?.phase === "prepared" ? null : findComposer();
  await h.start(workflow());
  await h.settle();
  assert.equal(h.stored().status, "paused");
  assert.equal(h.stored().phase, "prepared");
  assert.equal(h.stored().outbox.state, "prepared");
  assert.equal(h.stored().lastErrorCode, "composer_missing");
  assert.equal(h.page.text, PREFIX);
  assert.equal(h.page.clicks, 0);
  assert.equal(writes(h).length, 0);
  missing = false;
  assert.equal((await h.control("AIPM_RESUME")).ok, true);
  await h.settle();
  assertCompleted(h, [`${PREFIX}\n${MACRO}`, MACRO, MACRO]);
  assert.equal(writes(h).length, 3);
});

test("reload after combined prepared failure preserves the input and cannot append it again", async () => {
  const h = createWorkflowHarness({ initialComposerText: PREFIX });
  const { lifecycle } = installNavigation(h);
  await h.ready();
  const button = h.context.ChatGptAdapter.findSendButton();
  button.disabled = true;
  await h.start(workflow());
  await h.settle();
  assert.equal(h.stored().phase, "prepared");
  assert.equal(h.stored().outbox.state, "prepared");
  assert.equal(h.page.text, `${PREFIX}\n${MACRO}`);
  assert.equal(writes(h).length, 1);
  lifecycle.dispatch("pagehide");
  await h.reload(0, { preserveComposer: true });
  button.disabled = false;
  assert.equal((await h.control("AIPM_RESUME")).ok, false);
  await h.settle();
  assert.equal(h.page.text, `${PREFIX}\n${MACRO}`);
  assert.equal(h.page.clicks, 0);
  assert.equal(writes(h).length, 1);
});

test("combined prepared failure cannot omit its initial input after reload clears the composer", async () => {
  const h = createWorkflowHarness({ initialComposerText: PREFIX });
  const { lifecycle } = installNavigation(h);
  await h.ready();
  const button = h.context.ChatGptAdapter.findSendButton();
  button.disabled = true;
  await h.start(workflow());
  await h.settle();
  assert.equal(h.stored().phase, "prepared");
  assert.equal(h.stored().outbox.state, "prepared");
  assert.ok(h.stored().initialInputRequirement);
  const requirement = h.stored().initialInputRequirement;
  await reloadWithEmptyComposerAndNoLocalInput(h, lifecycle);
  button.disabled = false;
  assert.equal((await h.control("AIPM_RESUME")).ok, false);
  await h.settle();
  assert.equal(h.page.clicks, 0);
  assert.equal(writes(h).length, 1);
  assert.equal(h.page.text, "", "neither the lost prefix nor a macro-only replacement is restored");
  assert.equal(h.stored().cursor.sendsCompleted, 0);
  assert.deepEqual(h.stored().initialInputRequirement, requirement);
});

test("user Pause retains the initial-input obligation after outbox clearing and reload", async () => {
  const { h, lifetime } = await pauseCombinedInput();
  assert.equal(h.stored().outbox, null);
  assert.ok(h.stored().initialInputRequirement);
  const requirement = h.stored().initialInputRequirement;
  await reloadWithEmptyComposerAndNoLocalInput(h, lifetime.lifecycle);
  assert.equal((await h.control("AIPM_RESUME")).ok, false);
  await h.settle();
  assert.equal(h.page.clicks, 0);
  assert.equal(writes(h).length, 1);
  assert.equal(h.page.text, "");
  assert.equal(h.stored().cursor.sendsCompleted, 0);
  assert.deepEqual(h.stored().initialInputRequirement, requirement);
});

function workflowWithLeadingDelay() {
  const plan = workflow();
  plan.steps.unshift({ id: "before-first-input", type: "delay", durationMs: 2_000 });
  return plan;
}

test("reload during a leading delay cannot send the macro alone after losing the initial prefix", async () => {
  let interrupted = false;
  const h = createWorkflowHarness({
    initialComposerText: PREFIX,
    onSave({ run, context }) {
      if (!interrupted && run.status === "running" && run.phase === "delay") {
        interrupted = true;
        context.localRunnerToken += 1;
      }
    }
  });
  const { lifecycle } = installNavigation(h);
  await start(h, workflowWithLeadingDelay());
  assert.equal(interrupted, true);
  assert.equal(h.stored().status, "running");
  assert.equal(h.stored().phase, "delay");
  assert.ok(h.stored().initialInputRequirement);
  const requirement = h.stored().initialInputRequirement;
  assert.equal(writes(h).length, 0);
  await reloadWithEmptyComposerAndNoLocalInput(h, lifecycle);
  assert.equal(h.page.clicks, 0);
  assert.equal(writes(h).length, 0);
  assert.equal(h.stored().status, "paused");
  assert.equal(h.stored().cursor.sendsCompleted, 0);
  assert.deepEqual(h.stored().initialInputRequirement, requirement);
  assert.equal((await h.control("AIPM_RESUME")).ok, false);
  await h.settle();
  assert.equal(h.page.clicks, 0);
  assert.equal(writes(h).length, 0);
});

test("Pause and Resume during a leading delay keep a still-live first-input capability", async () => {
  let paused = false;
  let h;
  h = createWorkflowHarness({
    initialComposerText: PREFIX,
    async onSave({ run }) {
      if (!paused && run.status === "running" && run.phase === "delay") {
        paused = true;
        assert.equal((await h.control("AIPM_PAUSE")).ok, true);
      }
    }
  });
  installNavigation(h);
  await start(h, workflowWithLeadingDelay());
  assert.equal(paused, true);
  assert.equal(h.stored().status, "paused");
  assert.equal(h.stored().phase, "delay");
  assert.equal(h.page.text, PREFIX);
  assert.equal(writes(h).length, 0);
  assert.equal((await h.control("AIPM_RESUME")).ok, true);
  await h.settle();
  assertCompleted(h, [`${PREFIX}\n${MACRO}`, MACRO, MACRO]);
  assert.equal(writes(h).length, 3);
});

test("combined input hash is distinct from the unchanged macro hash and never persists prefix text", async () => {
  const h = createWorkflowHarness({ initialComposerText: PREFIX });
  installNavigation(h);
  await start(h);
  const hash = (text) => createHash("sha256").update(text, "utf8").digest("hex");
  const firstOutboxes = h.saves().filter((run) => run.outbox?.position?.sendsCompleted === 0)
    .map((run) => run.outbox);
  const laterOutboxes = h.saves().filter((run) => run.outbox?.position?.sendsCompleted > 0)
    .map((run) => run.outbox);
  assert.ok(firstOutboxes.length > 0);
  assert.ok(laterOutboxes.length > 0);
  for (const outbox of firstOutboxes) {
    assert.equal(outbox.promptHash, hash(MACRO));
    assert.equal(outbox.inputHash, hash(`${PREFIX}\n${MACRO}`));
    assert.notEqual(outbox.inputHash, outbox.promptHash);
  }
  for (const outbox of laterOutboxes) {
    assert.equal(outbox.promptHash, hash(MACRO));
    assert.equal(outbox.inputHash, hash(MACRO));
  }
  assert.equal(JSON.stringify(h.saves()).includes(PREFIX), false);
  assert.equal(JSON.stringify(h.diagnostics()).includes(PREFIX), false);
  assert.ok(h.saves().some((run) => run.cursor.sendsCompleted === 0 && run.initialInputRequirement));
  assert.equal(h.saves().some((run) => run.cursor.sendsCompleted > 0 && run.initialInputRequirement), false);
  assert.equal(h.stored().initialInputRequirement ?? null, null);
  assertCompleted(h, [`${PREFIX}\n${MACRO}`, MACRO, MACRO]);
});

test("confirmed delivery resumes generation waiting without resending or reappending first input", async () => {
  let blockerInjected = false;
  const h = createWorkflowHarness({
    initialComposerText: PREFIX,
    onSave({ run, page }) {
      if (!blockerInjected && run.outbox?.state === "confirmed") {
        blockerInjected = true;
        page.blocker = "ui-blocked";
      }
    }
  });
  installNavigation(h);
  await start(h);
  assert.equal(blockerInjected, true);
  assert.equal(h.page.clicks, 1);
  assert.equal(h.stored().status, "paused");
  assert.equal(h.stored().outbox.state, "confirmed");
  h.page.blocker = null;
  assert.equal((await h.control("AIPM_RESUME")).ok, true);
  await h.settle();
  assertCompleted(h, [`${PREFIX}\n${MACRO}`, MACRO, MACRO]);
  assert.equal(writes(h).length, 3);
});

for (const phase of ["prepared", "confirmed-wait"]) {
  for (const boundary of ["paused-write-response", "lease-release"]) {
    test(`${phase} Resume waits for ${boundary} finalization without latent clicks or duplicate append`,
      { timeout: 10_000 }, async () => {
        const entered = deferred();
        const release = deferred();
        let gateArmed = true;
        let blockerInjected = false;
        const hold = async () => {
          if (!gateArmed) return;
          gateArmed = false;
          entered.resolve();
          await release.promise;
        };
        const h = createWorkflowHarness({
          initialComposerText: PREFIX,
          async onSave({ run, page }) {
            if (phase === "confirmed-wait" && !blockerInjected && run.outbox?.state === "confirmed") {
              blockerInjected = true;
              page.blocker = "ui-blocked";
            }
            // State is committed already; only the old runner's response is held.
            if (boundary === "paused-write-response" && run.status === "paused" && run.phase === phase) {
              await hold();
            }
          },
          async onLease({ message, storedRun }) {
            if (boundary === "lease-release" && message.type === "AIPM_LEASE_RELEASE" &&
                storedRun?.status === "paused" && storedRun.phase === phase) {
              await hold();
            }
            return null;
          }
        });
        installNavigation(h);
        await h.ready();
        const button = h.context.ChatGptAdapter.findSendButton();
        if (phase === "prepared") button.disabled = true;
        assert.equal((await h.start(workflow())).ok, true);
        await entered.promise;
        const paused = h.stored();
        const token = h.context.localRunnerToken;
        const expectedClicks = phase === "prepared" ? 0 : 1;
        try {
          assert.equal(paused.status, "paused");
          assert.equal(paused.phase, phase);
          assert.ok(h.leaseSnapshot(), "the old invocation still owns its unreleased lease");
          const response = await h.control("AIPM_RESUME");
          assert.equal(response.ok, false, "Resume is rejected while the previous runner is finalizing");
          assert.match(response.error, /一時停止処理中/);
          assert.deepEqual(h.stored(), paused, "an early Resume cannot alter committed authority");
          assert.equal(h.context.localRunnerToken, token);
          assert.equal(h.page.clicks, expectedClicks);
          assert.equal(writes(h).length, 1);
        } finally {
          release.resolve();
          await h.settle();
        }
        assert.equal(h.context.localPauseFinalization, null);
        assert.equal(h.context.activeRunnerRunId, null);
        assert.equal(h.stored().status, "paused", "rejected early Resume creates no latent work");
        assert.equal(h.page.clicks, expectedClicks);
        assert.equal(writes(h).length, 1);
        button.disabled = false;
        h.page.blocker = null;
        assert.equal((await h.control("AIPM_RESUME")).ok, true);
        await h.settle();
        assertCompleted(h, [`${PREFIX}\n${MACRO}`, MACRO, MACRO]);
        assert.equal(writes(h).length, 3, "the retained first input is never appended again");
      });
  }
}

test("ambiguous submitted delivery never resends an approved combined input", async () => {
  const h = createWorkflowHarness({ initialComposerText: PREFIX, ackConfirms: false });
  installNavigation(h);
  await start(h);
  assert.equal(h.page.clicks, 1);
  assert.equal(h.stored().outbox.state, "submitted");
  assert.equal(h.stored().lastErrorCode, "submission_ambiguous");
  assert.equal((await h.control("AIPM_RESUME")).ok, false);
  await h.settle();
  assert.equal(h.page.clicks, 1);
  assert.equal(writes(h).length, 1);
  assert.equal(h.stored().cursor.sendsCompleted, 0);
});
