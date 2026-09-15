import test from "node:test";
import assert from "node:assert/strict";

import {
  deferred,
  flushAsync,
  installBackgroundHarness,
  makeRun
} from "./helpers/background-harness.mjs";
import { clone, createWorkflowHarness } from "./helpers/workflow-harness.mjs";

const harness = await installBackgroundHarness();

let nextTabId = 8_000;

function setupRun({ recovery = null } = {}) {
  nextTabId += 1;
  const tabId = nextTabId;
  const documentId = `document-${tabId}`;
  const documentInstanceId = `instance-${tabId}`;
  const run = makeRun({
    runId: `c8-run-${tabId}`,
    executionSessionId: harness.sessionId(),
    boundTabId: tabId,
    boundDocumentId: documentId,
    documentInstanceId,
    workflow: {
      ...makeRun().workflow,
      recovery: recovery ?? undefined
    }
  });
  harness.setTabs([{ id: tabId, active: true, windowId: 1, url: "https://chatgpt.com/" }]);
  harness.setDocument(tabId, { documentId, documentInstanceId });
  harness.putRun(tabId, run);
  return {
    tabId,
    run,
    sender: { tab: { id: tabId }, documentId },
    document: { documentId, documentInstanceId }
  };
}

function transientFailure() {
  return { error: new Error("transient executeScript rejection") };
}

async function readRun(setup, extra = {}) {
  return harness.invoke({
    type: "AIPM_RUN_GET",
    conversationKey: setup.run.conversationKey,
    documentInstanceId: setup.document.documentInstanceId,
    ...extra
  }, setup.sender);
}

async function waitFor(check, { timeoutMs = 1_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition was not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function repeatWorkflow(repeat) {
  return {
    schemaVersion: 1,
    id: `c8-repeat-${repeat}`,
    name: `C8 Repeat ${repeat}`,
    maxSends: repeat,
    steps: [{
      id: "repeat-prompt",
      type: "prompt",
      delivery: "send",
      prompt: "C8 EXACT",
      repeat,
      delayAfterMs: 0
    }]
  };
}

function recoveredObservation(boundary = "send-preflight", consecutiveUnavailable = 3) {
  return {
    outcome: "match",
    reason: "execute-script-rejected",
    attempt: consecutiveUnavailable + 1,
    totalAttempts: 5,
    durationMs: 350,
    boundary,
    episodeId: "c8-test-episode",
    consecutiveUnavailable,
    recoveryElapsedMs: 350
  };
}

function reverseObjectKeyOrder(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeyOrder);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).reverse().map(([key, nested]) => [key, reverseObjectKeyOrder(nested)])
  );
}

async function startWorkflow(harness, workflow) {
  await harness.ready();
  const response = await harness.start(workflow);
  await harness.settle();
  return response;
}

test("C8 RED R1: stable document recovers after the safe attempt burst is exhausted", async () => {
  const setup = setupRun();
  harness.setIdentityPlan(setup.tabId, [
    transientFailure(),
    transientFailure(),
    transientFailure(),
    setup.document
  ]);

  const response = await readRun(setup, {
    readOnlyObservation: true,
    authorityBoundary: "readiness"
  });

  assert.equal(response.ok, true);
  assert.equal(response.run?.runId, setup.run.runId);
  assert.equal(harness.identityProbeCount(setup.tabId), 4);
});

for (const attempts of [3, 5, 10]) {
  test(`C8 RED R3: identityAttempts=${attempts} can recover immediately after its legacy limit`, async () => {
    const recovery = attempts === 3
      ? null
      : { mode: "completion", identityAttempts: attempts };
    const setup = setupRun({ recovery });
    harness.setIdentityPlan(setup.tabId, [
      ...Array.from({ length: attempts }, transientFailure),
      setup.document
    ]);

    const response = await readRun(setup, {
      readOnlyRecovery: recovery,
      authorityBoundary: "run-read"
    });

    assert.equal(response.ok, true);
    assert.equal(response.run?.runId, setup.run.runId);
    assert.equal(harness.identityProbeCount(setup.tabId), attempts + 1);
  });
}

test("C8 R2: Repeat=5 continues exactly once after a recovered same-document observation", async () => {
  let recoveryInjected = false;
  const workflow = createWorkflowHarness({
    onRunGet: ({ message, storedRun, page }) => {
      if (!recoveryInjected && page.clicks === 1 && message.authorityBoundary === "readiness") {
        recoveryInjected = true;
        return { ok: true, run: storedRun, identityObservation: recoveredObservation("readiness") };
      }
      return null;
    }
  });

  const response = await startWorkflow(workflow, repeatWorkflow(5));

  assert.equal(response.ok, true);
  assert.equal(recoveryInjected, true);
  assert.equal(workflow.page.clicks, 5);
  assert.equal(new Set(workflow.clicks().map((entry) => `${entry.runId}:${entry.position}`)).size, 5);
  assert.equal(workflow.stored().status, "completed");
});

test("C8 diagnostics: a recovered episode records only bounded non-authoritative metadata", async () => {
  const workflow = createWorkflowHarness();
  await workflow.ready();

  assert.equal(workflow.context.recordDocumentIdentityRecoveryDiagnostic({
    identityObservation: recoveredObservation("readiness")
  }), true);
  await flushAsync();

  const recoveredDiagnostic = workflow.storageSnapshot("aipm.diagnostics.v1")?.find(
    (entry) => entry.type === "document_identity_recovered"
  );
  assert.equal(recoveredDiagnostic?.boundary, "readiness");
  assert.equal(recoveredDiagnostic?.consecutiveUnavailable, 3);
  assert.equal(JSON.stringify(recoveredDiagnostic).includes("document-"), false);
});

test("C8 recovered authority compares JSON structure independently of clone key order", async () => {
  let reordered = false;
  const workflow = createWorkflowHarness({
    onRunGet: ({ message, storedRun, page }) => {
      if (!reordered && page.clicks === 1 && message.authorityBoundary === "send-preflight") {
        reordered = true;
        return {
          ok: true,
          run: reverseObjectKeyOrder(storedRun),
          identityObservation: recoveredObservation("send-preflight")
        };
      }
      return null;
    }
  });

  const response = await startWorkflow(workflow, repeatWorkflow(5));

  assert.equal(response.ok, true);
  assert.equal(reordered, true);
  assert.equal(workflow.page.clicks, 5);
  assert.equal(workflow.stored().status, "completed");
});

for (const repeat of [20, 40]) {
  test(`C8 Repeat=${repeat}: deterministic recovered bursts preserve exact delivery`, async () => {
    const recoveryPoints = new Set([1, Math.floor(repeat / 2), repeat - 1]);
    const observed = new Set();
    const workflow = createWorkflowHarness({
      onRunGet: ({ message, storedRun, page }) => {
        if (message.authorityBoundary === "readiness" && recoveryPoints.has(page.clicks) && !observed.has(page.clicks)) {
          observed.add(page.clicks);
          return {
            ok: true,
            run: storedRun,
            identityObservation: recoveredObservation("readiness", page.clicks === repeat - 1 ? 4 : 2)
          };
        }
        return null;
      }
    });

    await startWorkflow(workflow, repeatWorkflow(repeat));

    assert.equal(workflow.page.clicks, repeat);
    assert.equal(new Set(workflow.clicks().map((entry) => `${entry.runId}:${entry.position}`)).size, repeat);
    assert.equal(workflow.stored().status, "completed");
    assert.deepEqual([...observed], [...recoveryPoints]);
  });
}

test("C8 R4: exhausted recovery remains unavailable and mutates nothing", async () => {
  const setup = setupRun();
  harness.setIdentityPlan(setup.tabId, Array.from({ length: 12 }, transientFailure));
  const before = clone(harness.storedRun(setup.tabId));

  const response = await harness.invoke({
    type: "AIPM_RUN_SET",
    run: { ...setup.run, phase: "submitting" },
    runTransition: "runner",
    conversationKey: setup.run.conversationKey,
    documentInstanceId: setup.document.documentInstanceId,
    authorityBoundary: "send-preflight"
  }, setup.sender);

  assert.equal(response.ok, false);
  assert.equal(response.errorCode, "DOCUMENT_IDENTITY_UNCONFIRMED");
  assert.equal(response.identityObservation.outcome, "unavailable");
  assert.equal(harness.identityProbeCount(setup.tabId), 12);
  assert.equal(harness.storedRun(setup.tabId).phase, before.phase);
  assert.equal(harness.storedRun(setup.tabId).stateRevision, before.stateRevision);
  assert.equal(harness.commandsDelivered(setup.tabId).length, 0);
});

test("C8 R4 runtime: exhausted recovery fail-closes only after the episode and never auto-resumes", async () => {
  let exhausted = false;
  const workflow = createWorkflowHarness({
    onRunGet: ({ message, storedRun, page }) => {
      if (!exhausted && page.clicks === 1 && message.authorityBoundary === "readiness") {
        exhausted = true;
        return {
          ok: false,
          errorCode: "DOCUMENT_IDENTITY_UNCONFIRMED",
          error: "identity unavailable",
          runId: storedRun.runId,
          identityObservation: {
            ...recoveredObservation("readiness", 5),
            outcome: "unavailable",
            attempt: 5
          }
        };
      }
      return null;
    }
  });

  await startWorkflow(workflow, repeatWorkflow(5));
  const clicksBeforeResume = workflow.page.clicks;
  const resume = await workflow.control("AIPM_RESUME");
  await workflow.settle();

  assert.equal(exhausted, true);
  assert.equal(clicksBeforeResume, 1);
  assert.equal(workflow.stored().resumable, false);
  assert.equal(resume.ok, false);
  assert.equal(workflow.page.clicks, 1);
});

test("C8 R5: first proven mismatch is final and starts no later probe", async () => {
  const setup = setupRun();
  harness.setIdentityPlan(setup.tabId, [
    { documentId: "different-document", documentInstanceId: "different-instance" },
    setup.document
  ]);

  const response = await readRun(setup, { authorityBoundary: "run-read" });

  assert.equal(response.ok, true);
  assert.equal(response.run, null);
  assert.equal(response.staleDocument, true);
  assert.equal(response.identityObservation.outcome, "mismatch");
  assert.equal(harness.identityProbeCount(setup.tabId), 1);
});

test("C8 R6: unavailable followed by mismatch is final and grants no mutation", async () => {
  const setup = setupRun();
  harness.setIdentityPlan(setup.tabId, [
    transientFailure(),
    { documentId: "different-document", documentInstanceId: "different-instance" },
    setup.document
  ]);

  const response = await harness.invoke({
    type: "AIPM_RUN_SET",
    run: { ...setup.run, phase: "submitting" },
    runTransition: "runner",
    conversationKey: setup.run.conversationKey,
    documentInstanceId: setup.document.documentInstanceId,
    authorityBoundary: "send-preflight"
  }, setup.sender);

  assert.equal(response.ok, false);
  assert.equal(response.errorCode, "DOCUMENT_IDENTITY_MISMATCH");
  assert.equal(harness.identityProbeCount(setup.tabId), 2);
  assert.equal(harness.storedRun(setup.tabId).phase, "ready");
});

test("C8 R7: a revision change during recovery rejects the stale writer", async () => {
  const setup = setupRun();
  harness.setIdentityPlan(setup.tabId, [
    transientFailure(),
    transientFailure(),
    () => {
      harness.putRun(setup.tabId, { ...harness.storedRun(setup.tabId), stateRevision: 2, phase: "paused" });
      return setup.document;
    }
  ]);

  const response = await harness.invoke({
    type: "AIPM_RUN_SET",
    run: { ...setup.run, phase: "submitting", stateRevision: 1 },
    runTransition: "runner",
    conversationKey: setup.run.conversationKey,
    documentInstanceId: setup.document.documentInstanceId,
    authorityBoundary: "send-preflight"
  }, setup.sender);

  assert.equal(response.ok, false);
  assert.equal(response.errorCode, "RUN_STATE_CONFLICT");
  assert.equal(harness.storedRun(setup.tabId).phase, "paused");
  assert.equal(harness.commandsDelivered(setup.tabId).length, 0);
});

test("C8 R8: a conversation change during recovery cannot receive the old authority", async () => {
  const setup = setupRun();
  harness.setIdentityPlan(setup.tabId, [
    transientFailure(),
    () => {
      harness.putRun(setup.tabId, {
        ...harness.storedRun(setup.tabId),
        conversationKey: "chatgpt:c:replacement-conversation",
        stateRevision: 2
      });
      return setup.document;
    }
  ]);

  const response = await readRun(setup, { authorityBoundary: "run-read" });

  assert.equal(response.ok, true);
  assert.equal(response.run, null);
  assert.equal(response.quarantined, true);
  assert.equal(response.quarantineReason, "conversation-changed");
  assert.equal(harness.commandsDelivered(setup.tabId).length, 0);
});

test("C8 R9: a document change after recovered authority but before click sends zero", async () => {
  let recovered = false;
  let changed = false;
  let workflow;
  workflow = createWorkflowHarness({
    onRunGet: ({ message, storedRun }) => {
      if (!recovered && message.authorityBoundary === "send-preflight") {
        recovered = true;
        return { ok: true, run: storedRun, identityObservation: recoveredObservation() };
      }
      return null;
    },
    onSave: ({ run }) => {
      if (!changed && run.phase === "submitting") {
        changed = true;
        workflow.rotateDocument("replacement-document");
      }
    }
  });
  await workflow.ready();
  workflow.pinCurrentDocument();
  await workflow.start(repeatWorkflow(1));
  await workflow.settle();

  assert.equal(recovered, true);
  assert.equal(changed, true);
  assert.equal(workflow.page.clicks, 0);
});

test("C8 R10: identity failure after click never retries the click", async () => {
  let clicked = false;
  let failed = false;
  const workflow = createWorkflowHarness({
    onClick: () => { clicked = true; },
    onRunGet: ({ storedRun }) => {
      if (clicked && !failed) {
        failed = true;
        return {
          ok: false,
          errorCode: "DOCUMENT_IDENTITY_UNCONFIRMED",
          error: "identity unavailable",
          identityObservation: {
            ...recoveredObservation("readiness"),
            outcome: "unavailable",
            attempt: 5,
            consecutiveUnavailable: 5
          },
          runId: storedRun?.runId
        };
      }
      return null;
    }
  });

  await startWorkflow(workflow, repeatWorkflow(1));

  assert.equal(failed, true);
  assert.equal(workflow.page.clicks, 1);
  assert.equal(workflow.stored().resumable, false);
});

test("C8 R11: true never-settle probes are time- and orphan-bounded", async () => {
  const setup = setupRun();
  harness.setIdentityPlan(setup.tabId, [{ never: true }, { never: true }, { never: true }]);
  const startedAt = Date.now();

  const response = await readRun(setup, { authorityBoundary: "run-read" });

  const elapsed = Date.now() - startedAt;
  assert.equal(response.ok, false);
  assert.equal(response.errorCode, "DOCUMENT_IDENTITY_UNCONFIRMED");
  assert.equal(harness.identityProbeCount(setup.tabId), 2);
  assert.ok(elapsed >= 9_000 && elapsed < 11_500, `bounded recovery took ${elapsed}ms`);
});

test("C8 R12: durable Stop wins while identity recovery is pending", async () => {
  const setup = setupRun();
  const gate = deferred();
  harness.setIdentityPlan(setup.tabId, [() => gate.promise, setup.document]);
  const readPending = readRun(setup, { readOnlyObservation: true, authorityBoundary: "readiness" });
  await waitFor(() => harness.identityProbeCount(setup.tabId) === 1);

  const stopPending = harness.relay({
    type: "AIPM_STOP",
    expectedRunId: setup.run.runId,
    expectedStateRevision: setup.run.stateRevision
  }, setup.tabId);
  await waitFor(() => harness.storedRun(setup.tabId)?.status === "stopped");
  gate.resolve(setup.document);
  const [readResponse, stopResponse] = await Promise.all([readPending, stopPending]);

  assert.equal(stopResponse.ok, true);
  assert.equal(stopResponse.stopCommitted, true);
  assert.equal(harness.storedRun(setup.tabId).status, "stopped");
  assert.notEqual(readResponse.run?.status, "running");
  assert.equal(harness.commandsDelivered(setup.tabId).filter((entry) => entry.payload.type === "AIPM_START").length, 0);
});

test("C8 lifecycle: a worker-session change invalidates a late recovery result", async () => {
  const setup = setupRun();
  const gate = deferred();
  harness.setIdentityPlan(setup.tabId, [() => gate.promise]);
  const pending = readRun(setup, { readOnlyObservation: true, authorityBoundary: "readiness" });
  await waitFor(() => harness.identityProbeCount(setup.tabId) === 1);

  await harness.triggerStartup();
  gate.resolve(setup.document);
  const response = await pending;

  assert.equal(response.ok, false);
  assert.equal(response.errorCode, "DOCUMENT_IDENTITY_UNCONFIRMED");
  assert.equal(response.identityObservation.reason, "execution-session-changed");
  assert.equal(harness.storedRun(setup.tabId), null);
});

test("C8 lifecycle: tab loading invalidates a late old-document match", async () => {
  const setup = setupRun();
  const gate = deferred();
  harness.setIdentityPlan(setup.tabId, [() => gate.promise]);
  const pending = readRun(setup, { readOnlyObservation: true, authorityBoundary: "readiness" });
  await waitFor(() => harness.identityProbeCount(setup.tabId) === 1);

  await harness.triggerTabLoading(setup.tabId);
  gate.resolve(setup.document);
  const response = await pending;

  assert.equal(response.ok, false);
  assert.equal(response.identityObservation.reason, "document-lifecycle-changed");
});

for (const [name, mutate] of [
  ["attachment", ({ page }) => { page.attachmentCount = 1; }],
  ["composer", ({ page }) => { page.text = "CHANGED"; }],
  ["blocker", ({ page }) => { page.blocker = { type: "rate-limit" }; }],
  ["generation", ({ page }) => { page.generationOverride = "generating"; }]
]) {
  test(`C8/C7 cross-boundary: recovered identity rechecks fresh ${name} state`, async () => {
    let injected = false;
    const workflow = createWorkflowHarness({
      onRunGet: ({ message, storedRun, page }) => {
        if (!injected && message.authorityBoundary === "send-preflight" && storedRun?.phase === "submitting") {
          injected = true;
          mutate({ page });
          return { ok: true, run: storedRun, identityObservation: recoveredObservation() };
        }
        return null;
      }
    });

    await startWorkflow(workflow, repeatWorkflow(1));

    assert.equal(injected, true);
    assert.equal(workflow.page.clicks, 0);
  });
}

test("C8/C7 cross-boundary: unchanged recovered state sends exactly once", async () => {
  let injected = false;
  const workflow = createWorkflowHarness({
    onRunGet: ({ message, storedRun }) => {
      if (!injected && message.authorityBoundary === "send-preflight" && storedRun?.phase === "submitting") {
        injected = true;
        return { ok: true, run: storedRun, identityObservation: recoveredObservation() };
      }
      return null;
    }
  });

  await startWorkflow(workflow, repeatWorkflow(1));

  assert.equal(injected, true);
  assert.equal(workflow.page.clicks, 1);
  assert.equal(workflow.stored().status, "completed");
});
