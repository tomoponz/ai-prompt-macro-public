import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

// This reproduces a mechanism compatible with the C7 CI failure, not its proven
// cause: that failure recorded a missing Run but no Start response. The fake tab
// changes document immediately after its first fresh status reply. Production
// Side Panel, background, and content-controller/runner code remain unchanged.
//
// Separate Node processes isolate the production modules' singleton Chrome
// globals and listener state, as required by the existing background harness.
const probe = String.raw`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { installSidePanelHarness, tick } from './tests/helpers/sidepanel-harness.mjs';
import { installBackgroundHarness } from './tests/helpers/background-harness.mjs';
import { createWorkflowHarness, CONTENT_VERSION, TAB_ID, SESSION_ID } from './tests/helpers/workflow-harness.mjs';
const withBarrier = process.argv.includes('--fresh');
const content = createWorkflowHarness({ initialAttachmentCount: 1, conversationKey: 'chatgpt:c:c7-existing-attachment' });
await content.ready();
const entry = {
  mode: 'workflow', editorRevision: 1,
  workflow: {
    schemaVersion: 1, maxSends: 1,
    steps: [{ id: 'one', type: 'prompt', delivery: 'send', prompt: 'SYNTHETIC C7', repeat: 1, delayAfterMs: 0 }]
  }
};
const panel = await installSidePanelHarness({
  tabIds: [TAB_ID],
  storageSeed: { 'aipm.selectedTab.v1': TAB_ID, 'aipm.uiByTab.v2': { [TAB_ID]: entry } }
});
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const heldTimers = new Set();
try {
  await tick();
  // Give the real panel the same previous observation returned by the race's
  // first status reply. This reaches document reconfirmation, rather than being
  // rejected earlier for an unrelated conversation/instance snapshot mismatch.
  panel.setRelayResponder(() => ({
    ok: true, provider: 'chatgpt', contentVersion: CONTENT_VERSION, pageReady: true,
    blocker: null, run: null, diagnostics: [],
    conversationKey: 'chatgpt:c:short-reply-repeat-20', instanceId: 'instance-before'
  }));
  await panel.click('refreshTabs');
  const panelChrome = globalThis.chrome;
  const bg = await installBackgroundHarness();
  const bgChrome = globalThis.chrome;
  bg.sessionStorageData['aipm.executionSession.v1'] = SESSION_ID;
  bg.setTabs([{ id: TAB_ID, windowId: 1, active: true, url: 'https://chatgpt.com/c/c7-existing-attachment' }]);
  bg.setDocument(TAB_ID, { documentId: 'document-before', documentInstanceId: 'instance-before' });
  globalThis.chrome = {
    ...bgChrome,
    runtime: { ...bgChrome.runtime, sendMessage: panelChrome.runtime.sendMessage },
    storage: { ...bgChrome.storage, local: panelChrome.storage.local }
  };
  // The rejection may arm the panel's reconciliation timer. Hold that unrelated
  // deadline so cleanup cannot leave a callback using restored global objects.
  globalThis.setTimeout = (callback, ms, ...args) => {
    if (ms === 15000) {
      const token = {};
      heldTimers.add(token);
      return token;
    }
    return realSetTimeout(callback, ms, ...args);
  };
  globalThis.clearTimeout = token => {
    if (!heldTimers.delete(token)) realClearTimeout(token);
  };
  let transitioned = false;
  let response = null;
  let statusReads = 0;
  bg.setStatusResponder(TAB_ID, async message => {
    statusReads += 1;
    const status = await content.control(message.type, message);
    if (!transitioned) {
      transitioned = true;
      bg.setDocument(TAB_ID, { documentId: 'document-after', documentInstanceId: content.context.instanceId });
      return { ...status, instanceId: 'instance-before', conversationKey: 'chatgpt:c:short-reply-repeat-20' };
    }
    return status;
  });
  bg.setCommandResponder(TAB_ID, message => content.control(message.type, message));
  panel.setRelayResponder(async message => {
    const value = await bg.invoke(message);
    if (message.payload.type === 'AIPM_START') response = value;
    return value;
  });
  panel.setListTabsResponder(message => bg.invoke(message));
  assert.equal(panel.el('start').disabled, false);
  if (withBarrier) {
    const source = fs.readFileSync('./tests/browser-fixture-e2e.mjs', 'utf8');
    const start = source.indexOf('function fixtureConversationKey(');
    const end = source.indexOf('async function selectReadyTarget(', start);
    assert.ok(start >= 0 && end > start, 'extract the actual browser readiness helper');
    const confirm = vm.runInNewContext(source.slice(start, end) + '; confirmStartReadiness', {
      assert, URL, chrome: globalThis.chrome,
      eventually: async (_name, operation) => {
        let lastError;
        for (let attempt = 0; attempt < 6; attempt += 1) {
          try { return await operation(); } catch (error) { lastError = error; }
        }
        throw lastError;
      }
    });
    const facade = {
      evaluate: (callback, arg) => callback(arg),
      locator: selector => ({
        click: () => panel.click(selector.slice(1)),
        inputValue: async () => panel.el(selector.slice(1)).value,
        isEnabled: async () => !panel.el(selector.slice(1)).disabled
      })
    };
    await confirm(facade, { url: () => 'https://chatgpt.com/c/c7-existing-attachment' }, TAB_ID, 'before Start');
  }
  await panel.click('start');
  await content.settle();
  assert.equal(panel.messages.filter(message => message.payload?.type === 'AIPM_START').length, 1,
    'one explicit Start; readiness must not retry it');
  assert.equal(content.clicks().length, 0);
  assert.equal(content.page.attachmentCount, 1);
  if (withBarrier) {
    assert.equal(response.ok, true);
    assert.equal(bg.commandsDelivered(TAB_ID).length, 1);
    assert.equal(content.stored()?.status, 'paused');
    assert.equal(content.stored()?.lastErrorCode, 'unexpected_attachment');
  } else {
    assert.equal(response.relayErrorCode, 'DOCUMENT_CHANGED_BEFORE_DELIVERY');
    assert.equal(bg.commandsDelivered(TAB_ID).length, 0);
    assert.equal(content.stored(), null);
  }
  console.log(JSON.stringify({
    withBarrier, statusReads,
    responseCode: response.relayErrorCode ?? 'ok',
    commandsDelivered: bg.commandsDelivered(TAB_ID).length,
    runStatus: content.stored()?.status ?? null,
    errorCode: content.stored()?.lastErrorCode ?? null,
    sends: content.clicks().length,
    attachments: content.page.attachmentCount
  }));
} finally {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  panel.restoreGlobals();
}
`;

for (const withBarrier of [false, true]) {
  test(`C7 compatible document race: ${withBarrier ? "current readiness preserves the attachment guard" : "enabled Start can be rejected without creating a Run"}`, () => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-", ...(withBarrier ? ["--fresh"] : [])], {
      cwd: repoRoot,
      input: probe,
      encoding: "utf8",
      timeout: 15_000
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const evidence = JSON.parse(result.stdout.trim());
    assert.equal(evidence.withBarrier, withBarrier);
    assert.equal(evidence.responseCode, withBarrier ? "ok" : "DOCUMENT_CHANGED_BEFORE_DELIVERY");
    assert.equal(evidence.commandsDelivered, withBarrier ? 1 : 0);
    assert.equal(evidence.runStatus, withBarrier ? "paused" : null);
    assert.equal(evidence.errorCode, withBarrier ? "unexpected_attachment" : null);
    assert.equal(evidence.sends, 0);
    assert.equal(evidence.attachments, 1);
  });
}

