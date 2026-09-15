import { buildAipmFlowMetaPrompt } from "./flow-authoring.js";

export function initializeFlowGuide({ goal, guideText, guideDetails, copyButton, copyStatus }) {
  function renderGuide() {
    guideText.value = buildAipmFlowMetaPrompt(goal.value);
    copyStatus.textContent = "";
  }

  async function copyGuide(event) {
    event.preventDefault();
    const text = guideText.value;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard-unavailable");
      await navigator.clipboard.writeText(text);
      copyStatus.textContent = "コピーしました。使いたいAIの会話に自分で貼り付けてください。";
    } catch {
      guideDetails.open = true;
      guideText.focus();
      guideText.select();
      copyStatus.textContent = "自動コピーできませんでした。選択された全文を Ctrl+C でコピーしてください。";
    }
  }

  guideText.readOnly = true;
  goal.addEventListener("input", renderGuide);
  copyButton.addEventListener("click", copyGuide);
  renderGuide();
}

function durationLabel(milliseconds) {
  for (const [unit, label] of [[3_600_000, "時間"], [60_000, "分"], [1000, "秒"]]) {
    if (milliseconds > 0 && milliseconds % unit === 0) return `${milliseconds / unit}${label}`;
  }
  return `${milliseconds}ミリ秒`;
}

export function renderFlowPlanSteps(container, plan) {
  container.replaceChildren();
  if (!plan?.workflow?.steps) return;

  const document = container.ownerDocument;
  const list = document.createElement("ol");
  list.className = "flow-plan-steps";
  plan.workflow.steps.forEach((step, index) => {
    const item = document.createElement("li");
    if (step.type === "prompt") {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      const excerpt = Array.from(step.prompt.replace(/\s+/gu, " ").trim());
      summary.textContent = `${step.repeat}回 · ${excerpt.slice(0, 48).join("")}${excerpt.length > 48 ? "…" : ""}`;
      const text = document.createElement("pre");
      text.textContent = step.prompt;
      details.append(summary, text);
      item.append(details);
    } else if (step.type === "delay") {
      item.textContent = `手順 ${index + 1} · ${durationLabel(step.durationMs)}待機`;
    } else if (step.type === "wait-until") {
      const latePolicy = { pause: "一時停止", run: "続行", skip: "スキップ" }[step.latePolicy];
      item.textContent = `手順 ${index + 1} · ${step.at} まで待機（遅れたとき: ${latePolicy}、許容する遅れ: ${durationLabel(step.graceMs)}）`;
    } else if (step.type === "checkpoint") {
      item.textContent = `手順 ${index + 1} · 確認ポイント: ${step.label}`;
    }
    list.append(item);
  });
  container.append(list);
}
