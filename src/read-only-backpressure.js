export function createReadOnlyBackpressure({
  backoffBaseMs = 1_200,
  backoffMaxMs = 4_800,
  maxUnderlyingLifetimeMs = 6_000,
  maxOutstandingPerKey = 2,
  maxObservationOutstandingPerKey = null,
  now = () => Date.now()
} = {}) {
  const entries = new Map();
  const pendingByKey = new Map();
  let nextGeneration = 0;
  const outstandingLimit = Number.isSafeInteger(maxOutstandingPerKey) && maxOutstandingPerKey > 0
    ? maxOutstandingPerKey
    : 2;
  const observationOutstandingLimit = Number.isSafeInteger(maxObservationOutstandingPerKey) &&
      maxObservationOutstandingPerKey > 0
    ? Math.min(outstandingLimit, maxObservationOutstandingPerKey)
    : outstandingLimit;

  function makeGateError(code, key, retryAfterMs = 0) {
    const error = new Error(code);
    error.code = code;
    error.key = key;
    error.retryAfterMs = Math.max(0, Math.ceil(retryAfterMs));
    return error;
  }

  function isCurrentEntry(key, entry) {
    return entries.get(key)?.generation === entry?.generation;
  }

  function currentEntry(key) {
    const entry = entries.get(key);
    if (entry?.underlyingPending && now() >= entry.absoluteDeadline) {
      entry.expire();
      return null;
    }
    return entry ?? null;
  }

  function pendingEntries(key) {
    let pending = pendingByKey.get(key);
    if (!pending) {
      pending = new Set();
      pendingByKey.set(key, pending);
    }
    return pending;
  }

  function normalizeAdmissionClass(value) {
    return value === "fresh-authority" ? "fresh-authority" : "observation";
  }

  function outstandingCount(key, admissionClass = null) {
    const pending = pendingByKey.get(key);
    if (!pending) return 0;
    if (admissionClass == null) return pending.size;
    const normalized = normalizeAdmissionClass(admissionClass);
    let count = 0;
    for (const entry of pending) {
      if (entry.admissionClass === normalized) count += 1;
    }
    return count;
  }

  function state(key, { admissionClass = "observation", fingerprint = null } = {}) {
    const normalizedClass = normalizeAdmissionClass(admissionClass);
    const entry = currentEntry(key);
    const outstanding = outstandingCount(key);
    const classOutstanding = outstandingCount(key, normalizedClass);
    const classLimit = normalizedClass === "observation"
      ? observationOutstandingLimit
      : outstandingLimit;
    if (!entry) {
      return {
        state: outstanding >= outstandingLimit || classOutstanding >= classLimit ? "saturated" : "idle",
        retryAfterMs: 0,
        outstanding,
        outstandingLimit,
        classOutstanding,
        classLimit
      };
    }
    if (entry.underlyingPending) {
      return {
        state: "in-flight",
        retryAfterMs: 0,
        outstanding,
        outstandingLimit,
        classOutstanding,
        classLimit
      };
    }
    const retryAfterMs = entry.admissionClass === normalizedClass
      ? entry.backoffUntil - now()
      : 0;
    if (retryAfterMs > 0) {
      return {
        state: "backoff",
        retryAfterMs: Math.ceil(retryAfterMs),
        sameFingerprint: typeof fingerprint === "string" && entry.fingerprint === fingerprint &&
          entry.admissionClass === normalizedClass,
        outstanding,
        outstandingLimit,
        classOutstanding,
        classLimit
      };
    }
    return {
      state: outstanding >= outstandingLimit || classOutstanding >= classLimit ? "saturated" : "idle",
      retryAfterMs: 0,
      outstanding,
      outstandingLimit,
      classOutstanding,
      classLimit
    };
  }

  function startContact(key, factory, {
    timeoutMs,
    timeoutErrorFactory = () => makeGateError("READ_ONLY_TIMEOUT", key),
    fingerprint = "default",
    admissionClass = "observation",
    continueRecoveryEpisode = false,
    shouldBackoff = () => true
  } = {}, owned = false) {
    const normalizedClass = normalizeAdmissionClass(admissionClass);
    const currentState = state(key, { admissionClass: normalizedClass, fingerprint });
    const existing = entries.get(key);
    if (currentState.state === "in-flight") {
      if (existing.fingerprint !== fingerprint || existing.admissionClass !== normalizedClass) {
        const error = makeGateError("READ_ONLY_CONTACT_BUSY", key);
        if (owned) throw error;
        return Promise.reject(error);
      }
      if (owned) throw makeGateError("READ_ONLY_CONTACT_BUSY", key);
      return existing.publicPromise;
    }
    if (currentState.state === "backoff" && !(continueRecoveryEpisode && currentState.sameFingerprint)) {
      const error = makeGateError("READ_ONLY_BACKOFF", key, currentState.retryAfterMs);
      if (owned) throw error;
      return Promise.reject(error);
    }
    if (currentState.state === "saturated" || outstandingCount(key) >= outstandingLimit) {
      const error = makeGateError("READ_ONLY_CONTACT_BUSY", key);
      if (owned) throw error;
      return Promise.reject(error);
    }

    const previousFailures = existing?.admissionClass === normalizedClass
      ? existing.failureStreak
      : 0;
    const startedAtMs = now();
    let releaseAdmission;
    const entry = {
      generation: nextGeneration += 1,
      ownerToken: Symbol("read-only-contact-owner"),
      fingerprint,
      admissionClass: normalizedClass,
      failureStreak: previousFailures,
      backoffUntil: 0,
      absoluteDeadline: startedAtMs + maxUnderlyingLifetimeMs,
      underlyingPending: true,
      failureRegistered: false,
      authoritySuperseded: false,
      expired: false,
      shouldBackoff,
      publicPromise: null,
      ownedHandle: null,
      releasePromise: new Promise((resolve) => { releaseAdmission = resolve; }),
      releaseAdmission: () => {},
      expire: () => {},
      supersede: () => { entry.authoritySuperseded = true; }
    };
    let admissionReleased = false;
    entry.releaseAdmission = () => {
      if (admissionReleased) return;
      admissionReleased = true;
      releaseAdmission();
    };
    entries.set(key, entry);
    pendingEntries(key).add(entry);

    const underlying = Promise.resolve().then(factory);
    let underlyingSettlement = null;
    let resolveUnderlyingSettlement;
    const underlyingSettlementPromise = new Promise((resolve) => {
      resolveUnderlyingSettlement = resolve;
    });
    underlying.then(
      (value) => {
        underlyingSettlement = Object.freeze({
          outcome: "fulfilled",
          settledAtMs: now(),
          value,
          generation: entry.generation,
          ownerToken: entry.ownerToken
        });
        resolveUnderlyingSettlement(underlyingSettlement);
      },
      (error) => {
        underlyingSettlement = Object.freeze({
          outcome: "rejected",
          settledAtMs: now(),
          error,
          generation: entry.generation,
          ownerToken: entry.ownerToken
        });
        resolveUnderlyingSettlement(underlyingSettlement);
      }
    );
    let timeoutId = null;
    let lifetimeId = null;
    let lifetimeActive = true;
    let rejectLifetime;
    const timeout = Number.isFinite(timeoutMs) && timeoutMs >= 0
      ? new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(timeoutErrorFactory()), timeoutMs);
        })
      : new Promise(() => {});
    const lifetime = new Promise((_, reject) => {
      rejectLifetime = reject;
    });

    function clearLifetime() {
      if (!lifetimeActive) return;
      lifetimeActive = false;
      if (lifetimeId != null) clearTimeout(lifetimeId);
    }

    entry.expire = () => {
      if (!lifetimeActive) return;
      lifetimeActive = false;
      entry.expired = true;
      entry.authoritySuperseded = true;
      if (lifetimeId != null) clearTimeout(lifetimeId);
      if (isCurrentEntry(key, entry)) entries.delete(key);
      entry.releaseAdmission();
      rejectLifetime(makeGateError("READ_ONLY_CONTACT_EXPIRED", key));
    };
    lifetimeId = setTimeout(entry.expire, maxUnderlyingLifetimeMs);

    function registerFailure(error) {
      if (entry.failureRegistered) return;
      if (!entry.shouldBackoff(error)) return;
      entry.failureRegistered = true;
      entry.failureStreak += 1;
      const delay = Math.min(backoffMaxMs, backoffBaseMs * (2 ** (entry.failureStreak - 1)));
      entry.backoffUntil = now() + delay;
    }

    entry.publicPromise = Promise.race([underlying, timeout, lifetime]).then(
      (value) => {
        if (timeoutId != null) clearTimeout(timeoutId);
        clearLifetime();
        entry.underlyingPending = false;
        if (isCurrentEntry(key, entry)) entries.delete(key);
        return value;
      },
      (error) => {
        if (timeoutId != null) clearTimeout(timeoutId);
        registerFailure(error);
        throw error;
      }
    );

    // A timeout cannot cancel a Chrome API request. Keep admission closed until the
    // underlying promise settles or its absolute quarantine lifetime expires.
    underlying.then(
      () => {
        const pending = pendingByKey.get(key);
        pending?.delete(entry);
        if (pending?.size === 0) pendingByKey.delete(key);
        entry.releaseAdmission();
        clearLifetime();
        entry.underlyingPending = false;
        if (!isCurrentEntry(key, entry)) return;
        if (!entry.failureRegistered) entries.delete(key);
      },
      (error) => {
        const pending = pendingByKey.get(key);
        pending?.delete(entry);
        if (pending?.size === 0) pendingByKey.delete(key);
        entry.releaseAdmission();
        registerFailure(error);
        clearLifetime();
        entry.underlyingPending = false;
        if (isCurrentEntry(key, entry) && !entry.failureRegistered) entries.delete(key);
      }
    );

    entry.ownedHandle = Object.freeze({
      key,
      generation: entry.generation,
      ownerToken: entry.ownerToken,
      fingerprint: entry.fingerprint,
      admissionClass: entry.admissionClass,
      startedAtMs,
      authorityExpiresAtMs: entry.absoluteDeadline,
      publicPromise: entry.publicPromise,
      settlementPromise: underlyingSettlementPromise,
      settlement: () => underlyingSettlement,
      isSuperseded: () => entry.authoritySuperseded || entry.expired,
      isSettlementEligible: (settlement, {
        key: expectedKey,
        fingerprint: expectedFingerprint,
        admissionClass: expectedAdmissionClass,
        deadlineMs
      } = {}) => {
        if (!settlement || entry.authoritySuperseded || entry.expired) return false;
        if (key !== expectedKey || entry.fingerprint !== expectedFingerprint ||
            entry.admissionClass !== expectedAdmissionClass) return false;
        if (settlement.ownerToken !== entry.ownerToken || settlement.generation !== entry.generation) return false;
        if (!Number.isFinite(settlement.settledAtMs) || !Number.isFinite(deadlineMs)) return false;
        return settlement.settledAtMs < deadlineMs &&
          settlement.settledAtMs < entry.absoluteDeadline;
      },
      supersede: () => entry.supersede(),
      expireIfDue: () => {
        if (now() >= entry.absoluteDeadline) entry.expire();
        return entry.expired;
      }
    });

    return owned ? entry.ownedHandle : entry.publicPromise;
  }

  function run(key, factory, options = {}) {
    return startContact(key, factory, options, false);
  }

  function startOwned(key, factory, options = {}) {
    return startContact(key, factory, options, true);
  }

  function forget(key) {
    const entry = entries.get(key);
    entries.delete(key);
    entry?.expire();
  }

  function join(key) {
    const entry = currentEntry(key);
    return entry?.underlyingPending ? entry.publicPromise : null;
  }

  function waitForRelease(key) {
    const entry = currentEntry(key);
    return entry?.underlyingPending ? entry.releasePromise : Promise.resolve();
  }

  return { run, startOwned, state, forget, join, waitForRelease, outstandingCount };
}
