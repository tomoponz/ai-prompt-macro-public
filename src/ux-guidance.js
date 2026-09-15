import { buildAipmFlowMetaPrompt } from "./flow-authoring.js";

const copyButton = document.querySelector("#copyAiHelper");
const helperText = document.querySelector("#aiHelperText");
const copyStatus = document.querySelector("#copyAiHelperStatus");
const goalInput = document.querySelector("#aiFlowGoal");

function renderHelperText() {
  if (helperText) helperText.value = buildAipmFlowMetaPrompt(goalInput?.value ?? "");
}

async function copyHelperText() {
  const text = helperText?.value ?? "";
  if (!text) return;

  try {
    if (!navigator.clipboard?.writeText) throw new Error("clipboard-unavailable");
    await navigator.clipboard.writeText(text);
    copyStatus.textContent = "コピーしました。使いたいAIの会話に貼り付けてください。";
  } catch {
    helperText.focus();
    helperText.select();
    copyStatus.textContent = "自動コピーできませんでした。選択された文章を Ctrl+C でコピーしてください。";
  }
}

copyButton?.addEventListener("click", copyHelperText);
goalInput?.addEventListener("input", renderHelperText);
renderHelperText();
