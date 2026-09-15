import assert from "node:assert/strict";
import test from "node:test";

import {
  CONVERSATION_KEY,
  clickPositions,
  createWorkflowHarness
} from "./helpers/workflow-harness.mjs";

const SAFE_RECOVERY = Object.freeze({
  mode: "safe",
  identityAttempts: 3,
  readiness: "normal",
  statusRecovery: "normal"
});

function repeatWorkflow(repeat = 3) {
  return {
    schemaVersion: 1,
    id: `c11-repeat-${repeat}`,
    name: "C11 identity blackout",
    maxSends: repeat,
    recovery: SAFE_RECOVERY,
    steps: [{
      id: "c11-prompt",
      type: "prompt",
      delivery: "send",
      prompt: "C11 BLACKOUT",
      repeat,
      delayAfterMs: 0
    }]
  };
}

function identityObservation(outcome, boundary, overrides = {}) {
  return {
    outcome,
    attempt: overrides.attempt ?? 1,
    totalAttempts: overrides.totalAttempts ?? 5,
    durationMs: overrides.durationMs ?? 4_008,
    boundary,
    episodeId: overrides.episodeId ?? `c11-${boundary}`,
    consecutiveUnavailable: overrides.consecutiveUnavailable ?? (outcome === "unavailable" ? 5 : 0),
    recoveryElapsedMs: overrides.recoveryElapsedMs ?? overrides.durationMs ?? 4_008,
    ...(outcome === "unavailable" ? { reason: overrides.reason ?? "timeout" } : {})
  };
}

function unavailableResponse(boundary, runId = null, overrides = {}) {
  return {
    ok: false,
    errorCode: "DOCUMENT_IDENTITY_UNCONFIRMED",
    error: "現在のdocument identityを再確認できないためRun取得を拒否しました。",
    runId,
    identityObservation: identityObservation("unavailable", boundary, overrides)
  };
}

function mismatchResponse(boundary) {
  return {
    ok: true,
    run: null,
    staleDocument: true,
    quarantineReason: "stale-document-request",
    identityObservation: identityObservation("mismatch", boundary, {
      attempt: 1,
      totalAttempts: 5,
      durationMs: 1,
      consecutiveUnavailable: 0,
      recoveryElapsedMs: 1
    })
  };
}

function recoveredResponse(storedRun, boundary, unavailableCount = 1) {
  return {
    ok: true,
    run: storedRun,
    identityObservation: identityObservation("match", boundary, {
      attempt: unavailableCount + 1,
      totalAttempts: 5,
      durationMs: 150,
      consecutiveUnavailable: unavailableCount,
      recoveryElapsedMs: 150,
      reason: "timeout"
    })
  };
}

function assertExactlyOncePositions(harness) {
  const positions = clickPositions(harness);
  assert.equal(new Set(positions.map((value) => JSON.stringify(value))).size, positions.length);
  return positions;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test("C11-R1 runner: a recovered short blackout revalidates the exact snapshot and completes without duplicates", async () => {
  let injected = false;
  const harness = createWorkflowHarness({
    generationMs: 300,
    onRunGet: ({ message, storedRun }) => {
      if (!injected && storedRun?.status === "running" && message.authorityBoundary === "readiness") {
        injected = true;
        return recoveredResponse(storedRun, "readiness");
      }
      return null;
    }
  });
  await harness.ready();
  assert.equal((await harness.start(repeatWorkflow(3))).ok, true);
  await harness.settle();

  assert.equal(injected, true);
  assert.equal(harness.stored().status, "completed");
  assert.equal(harness.stored().cursor.sendsCompleted, 3);
  assert.equal(harness.page.clicks, 3);
  assertExactlyOncePositions(harness);
});

test("C11-R2: readiness blackout beyond the legacy window suspends and completes exactly once", async () => {
  let injected = false;
  const harness = createWorkflowHarness({
    onRunGet: ({ message, storedRun }) => {
      if (!injected && storedRun?.status === "running" && message.authorityBoundary === "readiness") {
        injected = true;
        return recoveredResponse(storedRun, "readiness", 8);
      }
      return null;
    }
  });
  await harness.ready();
  assert.equal((await harness.start(repeatWorkflow(3))).ok, true);
  await harness.settle();

  assert.equal(injected, true);
  assert.equal(harness.stored().status, "completed");
  assert.equal(harness.stored().cursor.sendsCompleted, 3);
  assert.equal(harness.page.clicks, 3);
  assertExactlyOncePositions(harness);
});

test("C11-R3: lease-renew blackout after two confirmed clicks recovers and sends only the third prompt", async () => {
  let injected = false;
  const harness = createWorkflowHarness({
    generationMs: 300,
    onLease: ({ operation, storedRun, page }) => {
      if (!injected && operation === "renew" && page.clicks === 2 && storedRun?.outbox?.state === "confirmed") {
        injected = true;
        return {
          ok: true,
          renewed: true,
          identityObservation: identityObservation("match", "lease-renew", {
            attempt: 8,
            totalAttempts: 12,
            durationMs: 5_000,
            consecutiveUnavailable: 7,
            recoveryElapsedMs: 5_000,
            reason: "timeout"
          })
        };
      }
      return null;
    }
  });
  await harness.ready();
  assert.equal((await harness.start(repeatWorkflow(3))).ok, true);
  await harness.settle();

  assert.equal(injected, true);
  assert.equal(harness.page.clicks, 3);
  assert.equal(harness.stored().status, "completed");
  assert.equal(harness.stored().cursor.sendsCompleted, 3);
  assertExactlyOncePositions(harness);
});

test("C11-R4/R7: later MATCH resumes only the same exact Run after fresh fences", async () => {
  let recovered = false;
  const harness = createWorkflowHarness({
    onRunGet: ({ message, storedRun }) => {
      if (!recovered && storedRun?.status === "running" && message.authorityBoundary === "readiness") {
        recovered = true;
        return recoveredResponse(storedRun, "readiness", 8);
      }
      return null;
    }
  });
  await harness.ready();
  await harness.start(repeatWorkflow(3));
  await harness.settle();
  assert.equal(recovered, true);
  assert.equal(harness.stored().status, "completed");
  assert.equal(harness.stored().cursor.sendsCompleted, 3);
  assert.equal(harness.page.clicks, 3);
  await harness.reload();
  assert.equal(harness.stored().status, "completed");
  assert.equal(harness.page.clicks, 3);
});

test("C11-R5: a proven read-only mismatch durably terminalizes the exact Run", async () => {
  let injected = false;
  const harness = createWorkflowHarness({
    onRunGet: ({ message, storedRun }) => {
      if (!injected && storedRun?.status === "running" && message.authorityBoundary === "readiness") {
        injected = true;
        return mismatchResponse("readiness");
      }
      return null;
    }
  });
  await harness.ready();
  await harness.start(repeatWorkflow(1));
  await harness.settle();

  assert.equal(injected, true);
  assert.equal(harness.page.clicks, 0);
  assert.equal(harness.stored().status, "paused");
  assert.equal(harness.stored().resumable, false);
  assert.equal(harness.stored().pauseReason, "document_identity_mismatch");
  assert.equal(harness.stored().cursor.sendsCompleted, 0);
  assert.equal(harness.context.activeRunnerRunId, null);
});

test("C11-R8: durable Stop during a blocked identity read wins and later recovery cannot send", async () => {
  const entered = deferred();
  const release = deferred();
  let blocked = false;
  const harness = createWorkflowHarness({
    onRunGet: async ({ message, storedRun }) => {
      if (!blocked && storedRun?.status === "running" && message.authorityBoundary === "readiness") {
        blocked = true;
        entered.resolve();
        await release.promise;
        return recoveredResponse(storedRun, "readiness", 5);
      }
      return null;
    }
  });
  await harness.ready();
  await harness.start(repeatWorkflow(3));
  await entered.promise;
  const stopped = await harness.control("AIPM_STOP");
  assert.equal(stopped.ok, true);
  release.resolve();
  await harness.settle();
  await harness.reload();

  assert.equal(harness.stored().status, "stopped");
  assert.equal(harness.page.clicks, 0);
  assert.equal(harness.stored().cursor.sendsCompleted, 0);
});

test("C11-R9: conversation change during blackout is detected before any composer mutation", async () => {
  const entered = deferred();
  const release = deferred();
  let blocked = false;
  const harness = createWorkflowHarness({
    onRunGet: async ({ message, storedRun }) => {
      if (!blocked && storedRun?.status === "running" && message.authorityBoundary === "readiness") {
        blocked = true;
        entered.resolve();
        await release.promise;
        return recoveredResponse(storedRun, "readiness", 5);
      }
      return null;
    }
  });
  await harness.ready();
  await harness.start(repeatWorkflow(3));
  await entered.promise;
  harness.setConversationKey("chatgpt:c:c11-different-conversation");
  release.resolve();
  await harness.settle();

  assert.equal(harness.page.clicks, 0);
  assert.equal(harness.stored().status, "paused");
  assert.equal(harness.stored().cursor.sendsCompleted, 0);
});

test("C11-R11: an expired lease taken by another document cannot be resurrected after blackout", async () => {
  let harness;
  let attacked = false;
  harness = createWorkflowHarness({
    leaseTtlMs: 1_000,
    onLease: async ({ operation, storedRun }) => {
      if (!attacked && operation === "renew" && storedRun?.phase === "submitting") {
        attacked = true;
        harness.advance(2_000);
        const competing = harness.competingAcquire("foreign-document", "foreign-run");
        assert.equal(competing.lease?.nonce != null, true);
      }
      return null;
    }
  });
  await harness.ready();
  await harness.start(repeatWorkflow(1));
  await harness.settle();

  assert.equal(attacked, true);
  assert.equal(harness.page.clicks, 0);
  assert.equal(harness.stored().status, "paused");
  assert.equal(harness.stored().lastErrorCode, "lease_conflict");
  assert.equal(harness.leaseSnapshot()?.runId, "foreign-run");
});

test("C11-R12: final pre-click lease identity blackout leaves prepared outbox and Send 0", async () => {
  let injected = false;
  const harness = createWorkflowHarness({
    onLease: ({ operation, storedRun }) => {
      if (!injected && operation === "renew" && storedRun?.phase === "submitting" &&
          storedRun?.outbox?.state === "prepared") {
        injected = true;
        return unavailableResponse("lease-renew", storedRun.runId, { durationMs: 4_000 });
      }
      return null;
    }
  });
  await harness.ready();
  await harness.start(repeatWorkflow(1));
  await harness.settle();

  const stored = harness.stored();
  assert.equal(injected, true);
  assert.equal(harness.page.clicks, 0);
  assert.equal(stored.status, "paused");
  assert.equal(stored.resumable, false);
  assert.equal(stored.outbox?.state, "prepared");
  assert.equal(stored.cursor.sendsCompleted, 0);
});

test("C11 recovered authority rejects an outbox changed during suspension before composer mutation", async () => {
  let injected = false;
  const harness = createWorkflowHarness({
    onRunGet: ({ message, storedRun }) => {
      if (!injected && storedRun?.outbox?.state === "prepared" &&
          message.authorityBoundary === "send-preflight") {
        injected = true;
        return recoveredResponse({
          ...storedRun,
          outbox: { ...storedRun.outbox, promptHash: "forged-during-suspension" }
        }, "send-preflight", 7);
      }
      return null;
    }
  });
  await harness.ready();
  await harness.start(repeatWorkflow(1));
  await harness.settle();

  assert.equal(injected, true);
  assert.equal(harness.page.clicks, 0);
  assert.equal(harness.page.text, "");
  assert.equal(harness.stored().cursor.sendsCompleted, 0);
});

test("C11 post-click identity outage never retries an ambiguous delivery", async () => {
  let injected = false;
  const harness = createWorkflowHarness({
    generationMs: 1_000,
    onRunGet: ({ message, storedRun, page }) => {
      if (!injected && page.clicks === 1 && storedRun?.outbox?.state === "submitted" &&
          message.authorityBoundary === "readiness") {
        injected = true;
        return unavailableResponse("readiness", storedRun.runId, { durationMs: 10_000 });
      }
      return null;
    }
  });
  await harness.ready();
  await harness.start(repeatWorkflow(1));
  await harness.settle();
  await harness.reload();

  assert.equal(injected, true);
  assert.equal(harness.page.clicks, 1);
  assert.equal(harness.stored().status, "paused");
  assert.equal(harness.stored().resumable, false);
  assert.equal(harness.stored().outbox?.state, "submitted");
  assert.equal(harness.stored().cursor.sendsCompleted, 0);
  assertExactlyOncePositions(harness);
});

test("C11 deterministic stress: 25 seeded blackout classifications never duplicate, cross conversation, or send after Stop", async () => {
  const seed = 0xC1102026;
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
  const results = [];

  for (let index = 0; index < 25; index += 1) {
    const mode = next() % 4;
    let injected = false;
    const stopEntered = mode === 3 ? deferred() : null;
    const stopRelease = mode === 3 ? deferred() : null;
    const harness = createWorkflowHarness({
      generationMs: 200 + (next() % 600),
      onRunGet: async ({ message, storedRun }) => {
        if (injected || storedRun?.status !== "running" || message.authorityBoundary !== "readiness") return null;
        injected = true;
        if (mode === 0) return recoveredResponse(storedRun, "readiness", 1 + (next() % 4));
        if (mode === 1) return unavailableResponse("readiness", storedRun.runId);
        if (mode === 2) return mismatchResponse("readiness");
        stopEntered.resolve();
        await stopRelease.promise;
        return recoveredResponse(storedRun, "readiness", 5);
      }
    });
    await harness.ready();
    await harness.start(repeatWorkflow(3));
    if (mode === 3) {
      await stopEntered.promise;
      assert.equal((await harness.control("AIPM_STOP")).ok, true);
      stopRelease.resolve();
    }
    await harness.settle();
    const positions = assertExactlyOncePositions(harness);
    assert.ok(positions.length <= 3);
    assert.ok(harness.page.clicks <= 3);
    assert.equal(harness.conversationKey(), CONVERSATION_KEY);
    if (mode === 3) {
      assert.equal(harness.stored().status, "stopped");
      assert.equal(harness.page.clicks, 0);
    }
    results.push({ index, mode, clicks: harness.page.clicks, status: harness.stored().status });
  }

  assert.equal(results.length, 25);
  console.log(`C11_STRESS_SEED=${seed};CASES=${results.length}`);
});
