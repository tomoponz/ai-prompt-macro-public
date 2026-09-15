import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

function loadClassifier() {
  const source = fs.readFileSync(new URL("../src/content-core.js", import.meta.url), "utf8");
  const runnerSource = fs.readFileSync(new URL("../src/content-runner.js", import.meta.url), "utf8");
  const store = new Map();
  const context = vm.createContext({
    crypto: webcrypto,
    console,
    sessionStorage: {
      getItem(key) { return store.get(key) ?? null; },
      setItem(key, value) { store.set(key, String(value)); }
    }
  });
  vm.runInContext(source, context, { filename: "content-core.js" });
  vm.runInContext(runnerSource, context, { filename: "content-runner.js" });
  return {
    classify: context.classifyGenerationState,
    conversationAllowed: context.isConversationTransitionAllowed,
    errorResumable: context.isRunErrorResumable,
    conversationKeyForPath(pathname) {
      context.location = { origin: "https://chatgpt.com", pathname };
      return context.ChatGptAdapter.getConversationKey();
    },
    conversationIdentityForPath(pathname) {
      context.location = { origin: "https://chatgpt.com", pathname };
      return context.ChatGptAdapter.getConversationIdentity();
    },
    source,
    runnerSource
  };
}

const { classify, conversationAllowed, errorResumable, conversationKeyForPath, conversationIdentityForPath, source, runnerSource } = loadClassifier();

test("conversation paths resolve only supported canonical conversation ids", () => {
  assert.equal(conversationKeyForPath("/c/conversation-456"), "chatgpt:c:conversation-456");
  assert.equal(
    conversationKeyForPath("/g/g-p-project123/c/conversation-456"),
    "chatgpt:c:conversation-456"
  );

  const firstProject = conversationKeyForPath("/g/g-p-project-one/c/shared-conversation");
  const secondProject = conversationKeyForPath("/g/g-p-project-two/c/shared-conversation");
  assert.equal(firstProject, "chatgpt:c:shared-conversation");
  assert.equal(secondProject, firstProject);

  const firstTab = loadClassifier().conversationKeyForPath("/c/shared-conversation");
  const secondTab = loadClassifier().conversationKeyForPath("/g/g-p-project-two/c/shared-conversation");
  assert.equal(firstTab, secondTab, "the same conversation must share one lease key across tabs/routes");
});

test("Project conversation identity survives a fresh document instance", () => {
  const firstDocument = loadClassifier().conversationKeyForPath("/g/g-p-project123/c/reload-conversation");
  const reloadedDocument = loadClassifier().conversationKeyForPath("/g/g-p-project123/c/reload-conversation");
  assert.equal(firstDocument, "chatgpt:c:reload-conversation");
  assert.equal(reloadedDocument, firstDocument);
});

test("canonical root and Project New Chat routes are explicit and scoped", () => {
  const root = conversationIdentityForPath("/");
  assert.equal(root.kind, "new-chat");
  assert.match(root.key, /^chatgpt:new:root:/);

  const project = conversationIdentityForPath("/g/g-p-project123-my-project/project");
  assert.equal(project.kind, "project-new-chat");
  assert.match(project.key, /^chatgpt:new:project:g-p-project123-my-project:/);
  assert.notEqual(root.key, project.key, "SPA navigation from root New Chat to a Project must change identity");

  const anotherProject = conversationKeyForPath("/g/g-p-project456-other/project");
  assert.notEqual(project.key, anotherProject, "different Project New Chat scopes must not alias");

  const firstRootDocument = loadClassifier().conversationKeyForPath("/");
  const secondRootDocument = loadClassifier().conversationKeyForPath("/");
  assert.notEqual(firstRootDocument, secondRootDocument);

  const firstProjectDocument = loadClassifier().conversationKeyForPath("/g/g-p-project123-my-project/project");
  const secondProjectDocument = loadClassifier().conversationKeyForPath("/g/g-p-project123-my-project/project");
  assert.notEqual(firstProjectDocument, secondProjectDocument);
});

test("unknown and malformed routes fail closed instead of becoming New Chat lease keys", () => {
  for (const pathname of [
    "/unknown",
    "/project/c/conversation-456",
    "/c/",
    "/c/conversation-456/extra",
    "/c/conversation%2F456",
    "/g//c/conversation-456",
    "/g/g-p-project123/c/",
    "/g/g-p-project123/extra/c/conversation-456",
    "/g/g-p-project123/c/conversation-456/extra",
    "/g/g-p-project123!/c/conversation-456",
    "/g/g-p-project123/c/conversation_456",
    "/g/g-p-project123/project/",
    "/g/g-custom-gpt/project",
    "/workspace/team/conversations/future-123"
  ]) {
    const identity = conversationIdentityForPath(pathname);
    assert.equal(identity.kind, "unknown", pathname);
    assert.equal(identity.key, null, pathname);
    assert.throws(
      () => conversationKeyForPath(pathname),
      (error) => error?.code === "conversation_identity_unknown",
      pathname
    );
  }
});

test("same unknown conversation route cannot bypass the lease with per-document New Chat keys", () => {
  const pathname = "/workspace/team/conversations/future-shared";
  for (const document of [loadClassifier(), loadClassifier()]) {
    const identity = document.conversationIdentityForPath(pathname);
    assert.equal(identity.kind, "unknown");
    assert.equal(identity.key, null);
    assert.throws(
      () => document.conversationKeyForPath(pathname),
      (error) => error?.code === "conversation_identity_unknown"
    );
  }
});

test("canonical Project keys preserve wrong-conversation protection", () => {
  const first = conversationKeyForPath("/g/g-p-project123/c/conversation-one");
  const second = conversationKeyForPath("/g/g-p-project123/c/conversation-two");
  assert.notEqual(first, second);
  assert.equal(conversationAllowed({ conversationKey: first }, second), false);
});

test("generation state remains generating while stop control is present", () => {
  assert.equal(classify({ generating: true, composerWritable: true }), "generating");
});

test("empty-composer idle does not require a send control", () => {
  assert.equal(classify({ generating: false, composerWritable: true }), "idle");
});

test("non-writable composer fails closed", () => {
  assert.equal(classify({ generating: false, composerWritable: false }), "ambiguous");
});

test("generation readiness is not coupled to send-control presence", () => {
  assert.doesNotMatch(source, /sendControlPresent:\s*this\.hasSendControl\(\)/);
  assert.doesNotMatch(source, /hasSendControl\(\)\s*\{/);
});

test("send control detection does not fall back to an arbitrary form submit button", () => {
  assert.doesNotMatch(source, /form button\[type=['"]submit['"]\]/);
  assert.match(source, /button\[data-testid='send-button'\]/);
});

test("conversation transition never auto-adopts a New Chat canonical route", () => {
  assert.equal(conversationAllowed({ conversationKey: "chatgpt:c:abc" }, "chatgpt:c:abc"), true);
  assert.equal(conversationAllowed({ conversationKey: "chatgpt:new:root:tab1", outbox: { state: "submitted" } }, "chatgpt:c:abc"), false);
  assert.equal(conversationAllowed({ conversationKey: "chatgpt:new:project:g-p-one:tab1", outbox: { state: "confirmed" } }, "chatgpt:c:abc"), false);
  assert.equal(conversationAllowed({ conversationKey: "chatgpt:new:root:tab1", outbox: { state: "prepared" } }, "chatgpt:c:abc"), false);
  assert.equal(conversationAllowed({ conversationKey: "chatgpt:c:abc" }, "chatgpt:c:def"), false);
  assert.equal(conversationAllowed({ conversationKey: "chatgpt:c:abc" }, "chatgpt:new:root:tab1"), false);
  assert.equal(
    conversationAllowed({ conversationKey: "chatgpt:new:root:tab1" }, "chatgpt:new:project:g-p-one:tab1"),
    false,
    "SPA transitions between distinct New Chat scopes must fail closed"
  );
});

test("Navigation API migration proof code is removed", () => {
  assert.doesNotMatch(runnerSource, /beginSubmitNavigationProof|reconcileSubmitNavigation|newChatMigrationScope|canonicalSubmitNavigationTarget/);
  assert.doesNotMatch(runnerSource, /migrationProof|navigation-api-programmatic/);
});

test("unexpected conversation changes are guarded and non-resumable", () => {
  assert.match(runnerSource, /!isConversationTransitionAllowed\(run, ChatGptAdapter\.getConversationKey\(\)\)/);
  assert.match(runnerSource, /throw makeError\("conversation_changed"\)/);
  assert.match(runnerSource, /function assertConversationStillMatches\(run\)/);
  assert.match(runnerSource, /assertConversationStillMatches\(run\);\s*const composerBeforeWrite[\s\S]*?draft_present[\s\S]*?ChatGptAdapter\.writePrompt/);
  assert.match(runnerSource, /await renewLease\(lease, run\.runId\)[\s\S]*?assertPromptDeliveryRunBinding\(run, step, expectedPosition, promptHash, token, deliveryBinding\)[\s\S]*?requirePromptDeliveryState\(deliveryTransaction, step, deliveryBinding, deliveryMode\)/);
  assert.match(runnerSource, /finalSendButton\.click\(\)/);
});

test("submitted or confirmed outbox state can never become resumable after an error", () => {
  assert.equal(errorResumable({ outbox: { state: "submitted" } }, "generation_timeout"), false);
  assert.equal(errorResumable({ outbox: { state: "confirmed" } }, "service_error"), false);
  assert.equal(errorResumable({ outbox: { state: "prepared" } }, "generation_timeout"), true);
  assert.equal(errorResumable({ outbox: null }, "conversation_changed"), false);
});

test("irreversible write and click paths recheck Run control state after their final await", () => {
  const draftSource = runnerSource.slice(runnerSource.indexOf("async function prepareDraft("), runnerSource.indexOf("async function executeRun("));
  assert.match(draftSource, /const assertDraftAuthority = \(\) => \{\s*assertLocalRunnerToken\(token\);\s*assertConversationStillMatches\(run\);\s*if \(!sameJsonAuthorityValue\(draftBinding, currentDraftBinding\(\)\)\) throw makeError\("run_state_conflict"\)/);
  assert.match(draftSource, /await assertRunCanContinue\(run, token\);\s*assertDraftAuthority\(\);\s*const composerBeforeWrite[\s\S]*?ChatGptAdapter\.writePrompt\(step\.prompt, draftBinding\)/);
  const draftWriteSection = draftSource.slice(draftSource.indexOf("assertDraftAuthority();"), draftSource.indexOf("ChatGptAdapter.writePrompt("));
  assert.doesNotMatch(draftWriteSection, /\bawait\b/, "the fresh Draft authority check and write must stay synchronous");
  assert.match(runnerSource, /await renewLease\(lease, run\.runId\)[\s\S]*?assertPromptDeliveryRunBinding\(run, step, expectedPosition, promptHash, token, deliveryBinding\)[\s\S]*?const finalSendButton/);
  assert.match(runnerSource, /const blockerBeforeClick = ChatGptAdapter\.detectBlocker\(\);\s*if \(blockerBeforeClick\) throw blockerToError\(blockerBeforeClick\);[\s\S]*?finalSendButton\.click\(\)/);
  const finalCriticalSection = runnerSource.slice(
    runnerSource.lastIndexOf("assertPromptDeliveryRunBinding", runnerSource.indexOf("finalSendButton.click()")),
    runnerSource.indexOf("finalSendButton.click()")
  );
  assert.doesNotMatch(finalCriticalSection, /\bawait\b/, "the fresh final binding check and click must stay synchronous");
});
