import test from "node:test";
import assert from "node:assert/strict";

// Minimal extension-API harness so the real src/background.js can be exercised.
const listeners = { message: [] };
const storageData = {};
const sessionStorageData = { "aipm.executionSession.v1": "session-test" };
const currentDocumentIds = new Map();
const currentDocumentInstanceIds = new Map();

globalThis.chrome = {
  runtime: {
    getManifest() { return { version: "0.4.0" }; },
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener(fn) { listeners.message.push(fn); } }
  },
  sidePanel: { async setPanelBehavior() {} },
  permissions: { async contains() { return true; } },
  storage: {
    local: {
      async get(key) {
        if (typeof key === "string") return { [key]: storageData[key] };
        if (Array.isArray(key)) return Object.fromEntries(key.map((item) => [item, storageData[item]]));
        return { ...storageData };
      },
      async set(values) { Object.assign(storageData, values); },
      async remove(key) {
        for (const item of Array.isArray(key) ? key : [key]) delete storageData[item];
      }
    },
    session: {
      async get(key) {
        if (typeof key === "string") return { [key]: sessionStorageData[key] };
        return { ...sessionStorageData };
      },
      async set(values) { Object.assign(sessionStorageData, values); }
    }
  },
  tabs: {
    async query() { return [{ id: 70, active: true, windowId: 1, url: "https://chatgpt.com/" }]; },
    async sendMessage() { return { ok: true }; },
    onRemoved: { addListener() {} }
  },
  alarms: {
    async create() {}, async clear() { return true; }, async getAll() { return []; },
    onAlarm: { addListener() {} }
  },
  scripting: {
    async executeScript(details) {
      const tabId = details.target.tabId;
      return [{
        result: currentDocumentInstanceIds.get(tabId) ?? null,
        frameId: 0,
        documentId: currentDocumentIds.get(tabId) ?? `document-${tabId}`
      }];
    }
  },
  power: { requestKeepAwake() {}, releaseKeepAwake() {} }
};

await import(`../src/background.js?revision-test=${Date.now()}`);

function invokeRuntimeMessage(message, sender = {}) {
  return new Promise((resolve, reject) => {
    let handled = false;
    for (const listener of listeners.message) {
      if (listener(message, sender, resolve) === true) handled = true;
    }
    if (!handled) reject(new Error("message was not handled"));
  });
}

const runKey = (tabId) => `aipm.activeRun.v2.tab.${tabId}`;

function seedRun(tabId, overrides = {}) {
  currentDocumentIds.set(tabId, `document-${tabId}`);
  currentDocumentInstanceIds.set(tabId, `instance-${tabId}`);
  const run = {
    schemaVersion: 1,
    runId: "revision-run",
    provider: "chatgpt",
    contentVersion: "0.4.0",
    conversationKey: "chatgpt:c:revision",
    documentInstanceId: `instance-${tabId}`,
    executionSessionId: "session-test",
    replacesRunId: null,
    boundTabId: tabId,
    boundDocumentId: `document-${tabId}`,
    workflow: { schemaVersion: 1, maxSends: 5, steps: [] },
    plannedSends: 5,
    cursor: { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 },
    status: "running",
    phase: "ready",
    pauseReason: null,
    resumable: true,
    outbox: null,
    waitState: null,
    ...overrides
  };
  storageData[runKey(tabId)] = JSON.parse(JSON.stringify(run));
  return run;
}

function setRun(tabId, run, runTransition = "runner") {
  return invokeRuntimeMessage({
    type: "AIPM_RUN_SET",
    run,
    runTransition,
    conversationKey: "chatgpt:c:revision",
    documentInstanceId: `instance-${tabId}`
  }, { tab: { id: tabId }, documentId: currentDocumentIds.get(tabId) });
}

function getRun(tabId) {
  return invokeRuntimeMessage({
    type: "AIPM_RUN_GET",
    conversationKey: "chatgpt:c:revision",
    documentInstanceId: `instance-${tabId}`
  }, { tab: { id: tabId }, documentId: currentDocumentIds.get(tabId) });
}

// A runner that reads, writes, and carries the echoed state forward, the way
// content-controller.saveActiveRun() does via Object.assign(run, response.run).
async function writerFrom(tabId, snapshot, mutate, runTransition = "runner") {
  const next = JSON.parse(JSON.stringify(snapshot));
  mutate(next);
  const response = await setRun(tabId, next, runTransition);
  if (response.ok) Object.assign(next, response.run ?? {});
  return { response, run: next };
}

test("STAGE2-I: the current writer keeps making forward progress", async () => {
  const tabId = 401;
  seedRun(tabId);
  const first = await getRun(tabId);
  assert.equal(first.ok, true);

  let live = first.run;
  for (let sends = 1; sends <= 3; sends += 1) {
    const step = await writerFrom(tabId, live, (run) => {
      run.cursor = { stepIndex: 0, repeatIndex: sends, sendsCompleted: sends };
    });
    assert.equal(step.response.ok, true, `forward write ${sends} must be accepted`);
    live = step.run;
  }
  assert.equal(storageData[runKey(tabId)].cursor.sendsCompleted, 3);
});

test("STAGE2-A: an old running snapshot cannot overwrite a newer running state", async () => {
  const tabId = 402;
  seedRun(tabId);
  const observed = (await getRun(tabId)).run;

  const fresh = await writerFrom(tabId, observed, (run) => {
    run.cursor = { stepIndex: 0, repeatIndex: 2, sendsCompleted: 2 };
  });
  assert.equal(fresh.response.ok, true);

  // The pre-Pause writer still holds the snapshot it read before `fresh` landed.
  const stale = await writerFrom(tabId, observed, (run) => {
    run.cursor = { stepIndex: 0, repeatIndex: 1, sendsCompleted: 1 };
  });

  assert.equal(stale.response.ok, false, "a stale running snapshot must not be accepted");
  assert.equal(stale.response.errorCode, "RUN_STATE_CONFLICT");
  assert.equal(storageData[runKey(tabId)].cursor.sendsCompleted, 2, "stored progress must survive");
});

test("STAGE2-B: sendsCompleted can never decrease", async () => {
  const tabId = 403;
  seedRun(tabId, { cursor: { stepIndex: 0, repeatIndex: 3, sendsCompleted: 3 } });
  const observed = (await getRun(tabId)).run;

  const rollback = await writerFrom(tabId, observed, (run) => {
    run.cursor = { stepIndex: 0, repeatIndex: 1, sendsCompleted: 1 };
  });

  assert.equal(rollback.response.ok, false, "sendsCompleted must never rewind");
  assert.equal(storageData[runKey(tabId)].cursor.sendsCompleted, 3);
});

test("STAGE2-C: step and repeat progress can never roll back", async () => {
  const tabId = 404;
  seedRun(tabId, { cursor: { stepIndex: 3, repeatIndex: 0, sendsCompleted: 2 } });
  const observed = (await getRun(tabId)).run;

  const stepBack = await writerFrom(tabId, observed, (run) => {
    run.cursor = { stepIndex: 1, repeatIndex: 0, sendsCompleted: 2 };
  });
  assert.equal(stepBack.response.ok, false, "stepIndex must never rewind");
  assert.equal(storageData[runKey(tabId)].cursor.stepIndex, 3);

  const repeatBack = await writerFrom(tabId, (await getRun(tabId)).run, (run) => {
    run.cursor = { stepIndex: 3, repeatIndex: 0, sendsCompleted: 2 };
  });
  assert.equal(repeatBack.response.ok, true, "an unchanged cursor is still a legal write");

  seedRun(405, { cursor: { stepIndex: 2, repeatIndex: 4, sendsCompleted: 6 } });
  const observed405 = (await getRun(405)).run;
  const sameStepBack = await writerFrom(405, observed405, (run) => {
    run.cursor = { stepIndex: 2, repeatIndex: 1, sendsCompleted: 6 };
  });
  assert.equal(sameStepBack.response.ok, false, "repeatIndex must never rewind within a step");
});

test("STAGE2-D: a stale writer cannot resurrect a consumed outbox generation", async () => {
  const tabId = 406;
  seedRun(tabId, {
    phase: "generating",
    cursor: { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 },
    outbox: { id: "outbox-1", state: "confirmed", stepId: "prompt-a" }
  });
  const observed = (await getRun(tabId)).run;

  const consumed = await writerFrom(tabId, observed, (run) => {
    run.outbox = null;
    run.phase = "ready";
    run.cursor = { stepIndex: 0, repeatIndex: 1, sendsCompleted: 1 };
  });
  assert.equal(consumed.response.ok, true);

  const resurrect = await writerFrom(tabId, observed, (run) => {
    run.outbox = { id: "outbox-1", state: "confirmed", stepId: "prompt-a" };
  });

  assert.equal(resurrect.response.ok, false, "a consumed outbox must not be restored by a stale writer");
  assert.equal(storageData[runKey(tabId)].outbox, null);
  assert.equal(storageData[runKey(tabId)].cursor.sendsCompleted, 1);
});

test("STAGE2-E: a pre-Pause writer is rejected after Pause then Resume", async () => {
  const tabId = 407;
  seedRun(tabId);
  const prePause = (await getRun(tabId)).run;

  const paused = await writerFrom(tabId, prePause, (run) => {
    run.status = "paused";
    run.phase = "paused";
    run.pauseReason = "user-pause";
  }, "pause");
  assert.equal(paused.response.ok, true, "Pause must always be accepted");

  const resumed = await writerFrom(tabId, paused.run, (run) => {
    run.status = "running";
    run.pauseReason = null;
  }, "resume");
  assert.equal(resumed.response.ok, true, "Resume must always be accepted");

  const zombie = await writerFrom(tabId, prePause, (run) => {
    run.cursor = { stepIndex: 0, repeatIndex: 1, sendsCompleted: 1 };
  });

  assert.equal(zombie.response.ok, false, "the pre-Pause runner must not write after Resume");
  assert.equal(zombie.response.errorCode, "RUN_STATE_CONFLICT");
  assert.equal(storageData[runKey(tabId)].cursor.sendsCompleted, 0);
});

test("BLOCKER: a second Resume from the same paused revision is rejected", async () => {
  const tabId = 413;
  seedRun(tabId, {
    status: "paused",
    phase: "checkpoint",
    pauseReason: "manual-checkpoint",
    stateRevision: 10,
    cursor: { stepIndex: 1, repeatIndex: 0, sendsCompleted: 0 }
  });
  const observed = (await getRun(tabId)).run;

  const first = await writerFrom(tabId, observed, (run) => {
    run.status = "running";
    run.phase = "ready";
    run.pauseReason = null;
  }, "resume");
  assert.equal(first.response.ok, true);

  const duplicate = await writerFrom(tabId, observed, (run) => {
    run.status = "running";
    run.phase = "ready";
    run.pauseReason = null;
  }, "resume");
  assert.equal(duplicate.response.ok, false, "Resume must compare-and-set the paused state revision");
  assert.equal(duplicate.response.errorCode, "RUN_STATE_CONFLICT");
  assert.equal(storageData[runKey(tabId)].stateRevision, first.run.stateRevision);
});

test("STAGE2-F: no writer can revive a stopped Run", async () => {
  const tabId = 408;
  seedRun(tabId);
  const observed = (await getRun(tabId)).run;

  const stopped = await writerFrom(tabId, observed, (run) => {
    run.status = "stopped";
    run.phase = "stopped";
    run.pauseReason = "user-stop";
  }, "stop");
  assert.equal(stopped.response.ok, true, "Stop must always be accepted");

  for (const [label, snapshot] of [["stale", observed], ["current", stopped.run]]) {
    const revive = await writerFrom(tabId, snapshot, (run) => {
      run.status = "running";
      run.phase = "ready";
    });
    assert.equal(revive.response.ok, false, `${label} writer must not revive a stopped Run`);
    assert.equal(storageData[runKey(tabId)].status, "stopped");
  }
});

test("STAGE2-G: no writer can revive a completed Run", async () => {
  const tabId = 409;
  seedRun(tabId);
  const observed = (await getRun(tabId)).run;

  const completed = await writerFrom(tabId, observed, (run) => {
    run.status = "completed";
    run.phase = "completed";
    run.cursor = { stepIndex: 5, repeatIndex: 0, sendsCompleted: 5 };
  });
  assert.equal(completed.response.ok, true);

  for (const [label, snapshot] of [["stale", observed], ["current", completed.run]]) {
    const revive = await writerFrom(tabId, snapshot, (run) => {
      run.status = "running";
      run.phase = "ready";
    });
    assert.equal(revive.response.ok, false, `${label} writer must not revive a completed Run`);
    assert.equal(storageData[runKey(tabId)].status, "completed");
  }
});

test("STAGE2-H: an old document writer is rejected after a reload adopts the Run", async () => {
  const tabId = 410;
  seedRun(tabId);
  const oldDocumentSnapshot = (await getRun(tabId)).run;

  // Ctrl+R: the tab now hosts a new document, which adopts the Run.
  currentDocumentIds.set(tabId, "document-after-reload");
  currentDocumentInstanceIds.set(tabId, "instance-after-reload");
  const adopted = await invokeRuntimeMessage({
    type: "AIPM_RUN_GET",
    conversationKey: "chatgpt:c:revision",
    documentInstanceId: "instance-after-reload"
  }, { tab: { id: tabId }, documentId: "document-after-reload" });
  assert.equal(adopted.ok, true);
  assert.equal(adopted.run.boundDocumentId, "document-after-reload");

  const stale = await invokeRuntimeMessage({
    type: "AIPM_RUN_SET",
    run: { ...oldDocumentSnapshot, cursor: { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 } },
    runTransition: "runner",
    conversationKey: "chatgpt:c:revision",
    documentInstanceId: `instance-${tabId}`
  }, { tab: { id: tabId }, documentId: `document-${tabId}` });

  assert.equal(stale.ok, false, "the pre-reload document must not write after adoption");
  assert.equal(storageData[runKey(tabId)].boundDocumentId, "document-after-reload");
});

test("STAGE2-J: Start, Pause, Resume and Stop remain accepted in sequence", async () => {
  const tabId = 411;
  currentDocumentIds.set(tabId, `document-${tabId}`);
  currentDocumentInstanceIds.set(tabId, `instance-${tabId}`);
  delete storageData[runKey(tabId)];

  const started = await writerFrom(tabId, {
    schemaVersion: 1,
    runId: "lifecycle-run",
    provider: "chatgpt",
    contentVersion: "0.4.0",
    conversationKey: "chatgpt:c:revision",
    documentInstanceId: `instance-${tabId}`,
    executionSessionId: "session-test",
    replacesRunId: null,
    boundTabId: tabId,
    workflow: { schemaVersion: 1, maxSends: 3, steps: [] },
    plannedSends: 3,
    cursor: { stepIndex: 0, repeatIndex: 0, sendsCompleted: 0 },
    status: "running",
    phase: "ready",
    outbox: null,
    waitState: null
  }, () => {}, "start");
  assert.equal(started.response.ok, true, `Start must be accepted (got: ${started.response.error})`);

  const progressed = await writerFrom(tabId, started.run, (run) => {
    run.cursor = { stepIndex: 0, repeatIndex: 1, sendsCompleted: 1 };
  });
  assert.equal(progressed.response.ok, true);

  const paused = await writerFrom(tabId, progressed.run, (run) => {
    run.status = "paused";
    run.phase = "paused";
  }, "pause");
  assert.equal(paused.response.ok, true);

  const resumed = await writerFrom(tabId, paused.run, (run) => { run.status = "running"; }, "resume");
  assert.equal(resumed.response.ok, true);

  const stopped = await writerFrom(tabId, resumed.run, (run) => {
    run.status = "stopped";
    run.phase = "stopped";
  }, "stop");
  assert.equal(stopped.response.ok, true);
  assert.equal(storageData[runKey(tabId)].status, "stopped");
  assert.equal(storageData[runKey(tabId)].cursor.sendsCompleted, 1);
});

test("STAGE2: a legacy stored Run without a revision is adopted rather than bricked", async () => {
  const tabId = 412;
  seedRun(tabId);
  delete storageData[runKey(tabId)].stateRevision;

  const legacyWriter = await invokeRuntimeMessage({
    type: "AIPM_RUN_SET",
    run: { ...storageData[runKey(tabId)], cursor: { stepIndex: 0, repeatIndex: 1, sendsCompleted: 1 } },
    runTransition: "runner",
    conversationKey: "chatgpt:c:revision",
    documentInstanceId: `instance-${tabId}`
  }, { tab: { id: tabId }, documentId: `document-${tabId}` });

  assert.equal(legacyWriter.ok, true, "an in-flight Run from a pre-revision build must keep working");
  assert.equal(storageData[runKey(tabId)].cursor.sendsCompleted, 1);
});
