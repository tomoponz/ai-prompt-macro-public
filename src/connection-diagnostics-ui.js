import {
  diagnosticFromRelayFailure,
  projectConnectionDiagnostic,
  updateConnectionDiagnosticState
} from "./connection-diagnostics.js";
import { diagnosticDetailsRows } from "./diagnostics-ux.js";

const targetTab = document.querySelector("#targetTab");
const refreshTabs = document.querySelector("#refreshTabs");
const output = document.querySelector("#connectionDiagnostic");
const details = document.querySelector("#connectionDiagnosticDetails");

if (targetTab && output && details) {
  let diagnosticState = null;

  const selectedTabId = () => {
    const value = Number.parseInt(targetTab.value, 10);
    return Number.isInteger(value) ? value : null;
  };

  function renderDiagnostic(diagnostic) {
    const projection = projectConnectionDiagnostic(diagnostic);
    output.textContent = projection ? `${projection.title} — ${projection.summary} ${projection.nextAction}` : "";
    output.hidden = !projection;
    details.replaceChildren(...diagnosticDetailsRows(projection).map(([label, value]) => {
      const row = document.createElement("div");
      const term = document.createElement("dt");
      const description = document.createElement("dd");
      term.textContent = label;
      description.textContent = value;
      row.append(term, description);
      return row;
    }));
    details.hidden = !projection;
  }

  function selectDiagnosticTab(tabId = selectedTabId()) {
    diagnosticState = updateConnectionDiagnosticState(diagnosticState, {
      type: "target-changed",
      tabId
    });
    renderDiagnostic(null);
  }

  window.addEventListener("aipm:connection-diagnostic", (event) => {
    const diagnostic = diagnosticFromRelayFailure(event?.detail?.relayErrorCode, event?.detail?.tabId);
    const tabId = selectedTabId();
    if (!diagnostic || diagnostic.tabId !== tabId) return;
    if (!diagnosticState || diagnosticState.tabId !== tabId) selectDiagnosticTab(tabId);
    diagnosticState = updateConnectionDiagnosticState(diagnosticState, {
      type: "relay-failed",
      tabId,
      requestType: event?.detail?.requestType,
      diagnostic
    });
    renderDiagnostic(diagnosticState.latchedDiagnostic);
  });

  window.addEventListener("aipm:connection-diagnostic-success", (event) => {
    const tabId = selectedTabId();
    if (event?.detail?.tabId !== tabId || event?.detail?.requestType !== "AIPM_GET_STATUS") return;
    if (!diagnosticState || diagnosticState.tabId !== tabId) selectDiagnosticTab(tabId);
    diagnosticState = updateConnectionDiagnosticState(diagnosticState, {
      type: "relay-succeeded",
      tabId,
      requestType: event.detail.requestType
    });
    renderDiagnostic(diagnosticState.latchedDiagnostic);
  });

  targetTab.addEventListener("change", () => selectDiagnosticTab());
  refreshTabs?.addEventListener("click", () => selectDiagnosticTab());

  selectDiagnosticTab();
}
