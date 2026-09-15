// A minimal DOM/extension shim that lets `src/sidepanel.js` run unmodified under node:test.
//
// The Flow Library torture suite needs the *real* Side Panel handlers, not a re-implementation
// of them: every property under test (which entry an async Update overwrites, whether a tab
// switch invalidates an in-flight action, what a dirty-editor confirmation actually gates) is
// a property of those handlers' ordering, and a hand-written model would simply agree with
// itself.
//
// Only the globals `src/sidepanel.js` actually touches are provided, and everything a test
// needs to drive is exposed on the returned harness.
import fs from "node:fs";
import { webcrypto } from "node:crypto";

const sidepanelHtml = fs.readFileSync(new URL("../../src/sidepanel.html", import.meta.url), "utf8");

// Every id the panel markup defines. Reading them from the real HTML keeps the shim honest:
// a control added to the panel without a stub here would fail loudly rather than silently
// resolve to null.
export const PANEL_ELEMENT_IDS = [...sidepanelHtml.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);

function createClassList() {
  const names = new Set();
  return {
    names,
    add: (...items) => items.forEach((item) => names.add(item)),
    remove: (...items) => items.forEach((item) => names.delete(item)),
    contains: (item) => names.has(item),
    toggle(item, force) {
      const on = force === undefined ? !names.has(item) : Boolean(force);
      if (on) names.add(item);
      else names.delete(item);
      return on;
    }
  };
}

function createElement(tag = "div", id = null) {
  const listeners = new Map();
  const children = [];
  const attributes = new Map();
  const element = {
    tagName: String(tag).toUpperCase(),
    id: id ?? "",
    value: "",
    checked: false,
    textContent: "",
    disabled: false,
    hidden: false,
    className: "",
    rows: 0,
    spellcheck: false,
    type: "",
    min: "",
    max: "",
    draggable: false,
    files: null,
    children,
    style: {},
    dataset: {},
    classList: createClassList(),
    // Some controls are toggled through their wrapper; a lazily created stub parent keeps
    // that working without modelling the whole panel tree.
    parentElement: null,
    listeners,
    setAttribute: (name, value) => attributes.set(name, String(value)),
    removeAttribute: (name) => attributes.delete(name),
    getAttribute: (name) => (attributes.has(name) ? attributes.get(name) : null),
    append: (...nodes) => children.push(...nodes),
    appendChild: (node) => { children.push(node); return node; },
    replaceChildren: (...nodes) => { children.length = 0; children.push(...nodes); },
    insertBefore: (node) => { children.unshift(node); return node; },
    remove: () => {},
    focus: () => {},
    select: () => { element.selectionStart = 0; element.selectionEnd = element.value.length; },
    click: () => element.dispatch("click"),
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const bucket = listeners.get(type) ?? [];
      const index = bucket.indexOf(handler);
      if (index >= 0) bucket.splice(index, 1);
    },
    // Returns whatever the handlers return so a test can await an async click handler.
    dispatch(type, event = {}) {
      const bucket = [...(listeners.get(type) ?? [])];
      return Promise.all(bucket.map((handler) => handler({ type, target: element, preventDefault() {}, ...event })));
    }
  };
  element.parentElement = { classList: createClassList(), append: () => {}, remove: () => {}, insertBefore: () => {} };
  return element;
}

const FLOW_LIBRARY_LOCK = "aipm-flow-library-v1";

// Queues are per lock NAME, like the real Web Locks API. Two different names run
// independently; the same name never overlaps. A single global queue used to be
// close enough when the Library was the only lock, but the editor state store
// takes its own lock, and serializing the two against each other deadlocks any
// handler that saves the Library and then the editor state.
function createSerialLockManager() {
  const tails = new Map();
  const gates = new Map();
  const concurrentByName = new Map();
  // `concurrent` is how many locks are held right now across all names.
  // `maxConcurrent` is the most holders any SINGLE name ever had at once, which
  // is what "these writes must never interleave" actually means.
  const held = { concurrent: 0, maxConcurrent: 0, requests: 0 };
  return {
    held,
    // Park the next acquisition of one lock. This is the window a second Side Panel (or a
    // slower storage backend) opens between "the click captured its intent" and "the mutation
    // runs its freshness assertions", which is where wrong-entry overwrites would live.
    // Defaults to the Flow Library lock, which is the one every caller parks today.
    holdNext(name = FLOW_LIBRARY_LOCK) {
      let release;
      const waiting = new Promise((resolve) => { release = resolve; });
      let entered;
      const started = new Promise((resolve) => { entered = resolve; });
      gates.set(name, { waiting, entered });
      return { release, started };
    },
    request(name, _options, callback) {
      held.requests += 1;
      const previous = tails.get(name) ?? Promise.resolve();
      const operation = previous.then(async () => {
        const gate = gates.get(name);
        if (gate) {
          gates.delete(name);
          gate.entered();
          await gate.waiting;
        }
        const forName = (concurrentByName.get(name) ?? 0) + 1;
        concurrentByName.set(name, forName);
        held.concurrent += 1;
        held.maxConcurrent = Math.max(held.maxConcurrent, forName);
        try {
          return await callback();
        } finally {
          concurrentByName.set(name, (concurrentByName.get(name) ?? 1) - 1);
          held.concurrent -= 1;
        }
      });
      tails.set(name, operation.catch(() => {}));
      return operation;
    }
  };
}

function defaultTabStatus(tabId) {
  return {
    pageReady: true,
    generationState: "idle",
    blocker: null,
    conversationKey: `chatgpt:c:tab-${tabId}`,
    run: null,
    provider: "chatgpt",
    instanceId: `instance-${tabId}`,
    contentVersion: "0.4.0",
    discoveryError: null
  };
}

export async function installSidePanelHarness({ tabIds = [1, 2], storageSeed = {} } = {}) {
  const elements = new Map();
  for (const id of PANEL_ELEMENT_IDS) elements.set(id, createElement("div", id));

  const storage = new Map(Object.entries(structuredClone(storageSeed)));
  const storageChangeListeners = [];
  const messages = [];
  const confirmations = [];
  const clipboard = [];
  const downloads = [];
  const dispatchedEvents = [];
  const lockManager = createSerialLockManager();

  let confirmResponder = () => true;
  let listTabsResponder = null;
  let relayResponder = null;
  let storageMutationHook = null;
  let storageReadHook = null;
  let windowResponder = async () => ({ id: 1 });

  const document = {
    querySelector(selector) {
      const id = String(selector).startsWith("#") ? String(selector).slice(1) : null;
      return id && elements.has(id) ? elements.get(id) : null;
    },
    querySelectorAll: () => [],
    createElement: (tag) => Object.assign(createElement(tag), { ownerDocument: document }),
    createDocumentFragment: () => createElement("fragment"),
    addEventListener: () => {},
    documentElement: createElement("html"),
    body: createElement("body")
  };

  for (const element of elements.values()) element.ownerDocument = document;

  const windowShim = {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: (event) => { dispatchedEvents.push(event); return true; },
    confirm: (message) => {
      confirmations.push(message);
      return confirmResponder(message, confirmations.length);
    }
  };

  const chromeShim = {
    windows: { getCurrent: (...args) => windowResponder(...args) },
    runtime: {
      async sendMessage(message) {
        messages.push(structuredClone(message));
        if (message?.type === "AIPM_LIST_CHATGPT_TABS") {
          if (listTabsResponder) return listTabsResponder(message);
          return {
            ok: true,
            tabs: tabIds.map((tabId) => ({
              tabId,
              windowId: 1,
              active: tabId === tabIds[0],
              status: defaultTabStatus(tabId)
            })),
            partial: false,
            failedChatGptTabs: 0,
            unknownTabFailures: 0,
            discoveryErrors: [],
            serviceWorkerVersion: "0.4.0",
            siteAccessGranted: true
          };
        }
        if (message?.type === "AIPM_RELAY_TO_CHATGPT") {
          if (relayResponder) return relayResponder(message);
          const tabId = message.targetTabId ?? tabIds[0];
          return {
            ok: true,
            provider: "chatgpt",
            contentVersion: "0.4.0",
            pageReady: true,
            generationState: "idle",
            blocker: null,
            conversationKey: `chatgpt:c:tab-${tabId}`,
            instanceId: `instance-${tabId}`,
            run: null,
            diagnostics: []
          };
        }
        if (message?.type === "AIPM_HAS_ACTIVE_RUNS") return { ok: true, active: false, count: 0 };
        return { ok: true };
      }
    },
    storage: {
      local: {
        async get(key) {
          if (storageReadHook) await storageReadHook(structuredClone(key));
          const read = (item) => (storage.has(item) ? structuredClone(storage.get(item)) : undefined);
          if (typeof key === "string") return { [key]: read(key) };
          if (Array.isArray(key)) return Object.fromEntries(key.map((item) => [item, read(item)]));
          return Object.fromEntries([...storage.entries()].map(([item, value]) => [item, structuredClone(value)]));
        },
        async set(values) {
          if (storageMutationHook) await storageMutationHook(structuredClone(values));
          for (const [key, value] of Object.entries(values)) storage.set(key, structuredClone(value));
        },
        async remove(key) {
          for (const item of Array.isArray(key) ? key : [key]) storage.delete(item);
        }
      },
      // Registry only. Nothing fires it implicitly, so a set() made by the code
      // under test does not turn into a self-notification; a test that wants to
      // model ANOTHER surface writing calls fireStorageChanged explicitly.
      onChanged: {
        addListener(listener) {
          if (typeof listener === "function") storageChangeListeners.push(listener);
        }
      }
    }
  };

  const previousGlobals = {};
  const install = (name, value, { defineProperty = false } = {}) => {
    previousGlobals[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    if (defineProperty) {
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    } else {
      globalThis[name] = value;
    }
  };

  install("document", document);
  install("window", windowShim);
  install("chrome", chromeShim);
  // Node defines `navigator` as an accessor, so it has to be redefined rather than assigned.
  install("navigator", {
    locks: lockManager,
    clipboard: { async writeText(text) { clipboard.push(text); } }
  }, { defineProperty: true });
  install("URL", Object.assign(class ShimUrl extends URL {}, {
    createObjectURL: (blob) => {
      downloads.push(blob);
      return `blob:aipm/${downloads.length}`;
    },
    revokeObjectURL: () => {}
  }), { defineProperty: true });
  install("Blob", class Blob {
    constructor(parts) { this.parts = parts; }
  });
  install("CustomEvent", class CustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail ?? null;
    }
  });
  // The panel arms two polling intervals at import time; the tests drive it explicitly.
  install("setInterval", () => 0);
  if (!globalThis.crypto?.randomUUID) install("crypto", webcrypto);

  await import(`../../src/sidepanel.js?torture=${Date.now()}-${Math.random()}`);

  const el = (id) => {
    const element = elements.get(id);
    if (!element) throw new Error(`unknown Side Panel element #${id}`);
    return element;
  };

  return {
    el,
    elements,
    storage,
    messages,
    confirmations,
    clipboard,
    downloads,
    dispatchedEvents,
    lockManager,
    setConfirmResponder: (responder) => { confirmResponder = responder; },
    setListTabsResponder: (responder) => { listTabsResponder = responder; },
    setWindowResponder: (responder) => { windowResponder = responder; },
    setRelayResponder: (responder) => { relayResponder = responder; },
    // Called with every chrome.storage.local.set payload before it lands; may await, which
    // is how a test holds a Library mutation open across a concurrent UI change.
    setStorageMutationHook: (hook) => { storageMutationHook = hook; },
    setStorageReadHook: (hook) => { storageReadHook = hook; },
    // Models another surface having written: delivers a storage.onChanged record
    // without touching the backing store, so a test controls both halves.
    fireStorageChanged: (changes, areaName = "local") => {
      for (const listener of storageChangeListeners) listener(changes, areaName);
    },
    click: (id, event) => el(id).dispatch("click", event),
    change: (id, event) => el(id).dispatch("change", event),
    input: (id, event) => el(id).dispatch("input", event),
    library: () => structuredClone(storage.get("aipm.flowLibrary.v1") ?? null),
    libraryEntry: (entryId) => (storage.get("aipm.flowLibrary.v1")?.entries ?? [])
      .find((entry) => entry.id === entryId) ?? null,
    listedIds: () => el("flowLibraryList").children.map((option) => option.value),
    restoreGlobals() {
      for (const [name, descriptor] of Object.entries(previousGlobals)) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    }
  };
}

export const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

export function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
