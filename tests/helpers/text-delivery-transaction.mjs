import assert from "node:assert/strict";

function bindingMatches(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

// Legacy runner fixtures model ordinary TEXT delivery with small adapter stubs. C9 makes
// the local delivery transaction explicit, so those fixtures must expose the same bounded
// surface without gaining paste-attachment authority.
export function withTextDeliveryTransaction(adapter, context = null) {
  assert.equal(typeof adapter?.writePrompt, "function");
  assert.equal(typeof adapter?.findComposer, "function");
  assert.equal(typeof adapter?.getComposerText, "function");
  const originalWritePrompt = adapter.writePrompt.bind(adapter);

  adapter.writePrompt = (text, binding) => {
    assert.ok(binding && typeof binding === "object", "production writePrompt requires an explicit binding");
    originalWritePrompt(text);
    return {
      active: true,
      binding: { ...binding },
      composer: adapter.findComposer(),
      mode: null
    };
  };
  adapter.inspectPromptDelivery = (transaction, expectedText, binding, expectedMode = null) => {
    const attachmentState = adapter.getComposerAttachmentState?.() ?? { known: true, count: 0 };
    const valid = transaction?.active === true && transaction.composer === adapter.findComposer() &&
      bindingMatches(transaction.binding, binding) && attachmentState.known === true &&
      attachmentState.count === 0 && adapter.getComposerText(transaction.composer) === expectedText &&
      (!expectedMode || expectedMode === "text");
    return valid ? { ok: true, mode: "text" } : { ok: false, reason: "text-mismatch" };
  };
  adapter.getPromptDeliveryAckState = (transaction, binding, mode) => {
    const attachmentState = adapter.getComposerAttachmentState?.() ?? { known: true, count: 0 };
    const known = transaction?.active === true && transaction.composer === adapter.findComposer() &&
      bindingMatches(transaction.binding, binding) && mode === "text" && attachmentState.known === true;
    return {
      known,
      cleared: known && attachmentState.count === 0 && adapter.getComposerText(transaction.composer) === ""
    };
  };
  // Opt-in only: fixtures that pass the loaded content-core context exercise the real
  // acceptance watch, so the transient generation edge is captured by production code
  // rather than by this shim. Fixtures that do not pass a context keep the legacy surface.
  if (context) {
    adapter.startDeliveryAcceptanceWatch = (transaction) => {
      context.startDeliveryAcceptanceWatch(transaction, () => (adapter.isGenerating() ? {} : null));
    };
    adapter.hasObservedDeliveryGeneration = (transaction, binding) => {
      if (transaction?.active !== true || !bindingMatches(transaction.binding, binding)) return false;
      if (transaction.generationSeen !== true) transaction.acceptanceCheck?.();
      return transaction.generationSeen === true;
    };
  }
  adapter.finishPromptDelivery = (transaction) => {
    if (transaction) transaction.active = false;
    context?.stopDeliveryAcceptanceWatch?.(transaction);
  };
  return adapter;
}
