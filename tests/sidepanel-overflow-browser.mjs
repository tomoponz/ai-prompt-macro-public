// Offline layout regression: real Side Panel markup, CSS and theme application.
// Run state is demonstration data. No extension, worker, provider page, user
// profile, storage, clipboard or external request is involved.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { THEMES } from "../src/themes/registry.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const phase = process.argv.find(arg => arg.startsWith("--phase="))?.slice(8) ?? "verification";
assert.match(phase, /^[a-z0-9-]+$/);
const quick = process.argv.includes("--quick");
const themeFilter = process.argv.find(arg => arg.startsWith("--theme="))?.slice(8);
const baselineCssFile = process.argv.find(arg => arg.startsWith("--baseline-css="))?.slice(15);
const baselineCss = baselineCssFile ? fs.readFileSync(path.resolve(root, baselineCssFile), "utf8") : null;
// Default evidence must not dirty a checkout or block clean-tree packaging.
// An explicit directory still lets CI/local callers retain a chosen evidence set.
const evidenceRoot = process.env.AIPM_LAYOUT_EVIDENCE_DIR ??
  fs.mkdtempSync(path.join(os.tmpdir(), "aipm-sidepanel-layout-"));
const evidence = path.resolve(evidenceRoot, phase);
fs.mkdirSync(evidence, { recursive: true });
const widths = quick ? [320, 420] : [280, 320, 360, 380, 420, 480];
const themes = themeFilter ? THEMES.filter(theme => theme.id === themeFilter) : quick ? THEMES.filter(theme => theme.id === "default") : THEMES;
assert.ok(themes.length, "theme filter must select a known theme");
const densities = quick ? ["comfortable"] : ["comfortable", "compact"];
const languages = quick ? ["ja"] : ["ja", "en"];
const variants = [
  { state: "running", completed: 9, total: 20 },
  { state: "user-paused", completed: 20, total: 20 },
  { state: "fail-closed", completed: 9, total: 20 },
  { state: "fail-closed", completed: 50, total: 50 }
];
const html = fs.readFileSync(path.join(root, "src/sidepanel.html"), "utf8")
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
const browser = await chromium.launch({ headless: true });
const results = [];
const screenshots = [];
const errors = [];
const blockedRequests = [];
try {
  const context = await browser.newContext({ viewport: { width: 320, height: 900 } });
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== "https://apm-layout.test" || !url.pathname.startsWith("/src/")) {
      blockedRequests.push(url.origin + url.pathname);
      return route.abort();
    }
    const relative = decodeURIComponent(url.pathname.slice(1));
    const file = path.resolve(root, relative);
    if (!file.startsWith(path.join(root, "src") + path.sep) || !fs.existsSync(file)) {
      blockedRequests.push(url.origin + url.pathname);
      return route.abort();
    }
    return route.fulfill({ status: 200,
      contentType: file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "text/javascript" : "text/html",
      body: relative === "src/sidepanel.html" ? html :
        relative === "src/sidepanel.css" && baselineCss !== null ? baselineCss : fs.readFileSync(file) });
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(String(error)));
  await page.goto("https://apm-layout.test/src/sidepanel.html");
  await page.evaluate(async () => {
    const { applyAppearance } = await import("./theme.js");
    globalThis.applyLayoutAppearance = appearance => applyAppearance(document.documentElement, appearance);
    document.querySelector("main").prepend(document.querySelector("#runCard"));
    document.querySelector("#targetTab").innerHTML = '<option>Demonstration conversation</option>';
    document.querySelector("#quickPrompt").value = "Demonstration prompt";
    document.querySelector("#runDetails").hidden = false;
    document.querySelector("#progress").hidden = false;
    document.querySelector("#activeRunWarning").hidden = false;
    document.querySelector("#runCard").dataset.compact = "false";
    document.querySelector("#runCard").dataset.active = "true";
  });
  for (const theme of themes) {
    const modes = theme.stance === "both" ? ["light", "dark"] : [theme.stance];
    for (const mode of modes) for (const density of densities) {
      await page.evaluate(appearance => applyLayoutAppearance(appearance), {
        theme: theme.id, mode, density, accent: "theme"
      });
      await page.waitForFunction(() => [...document.styleSheets].some(sheet =>
        sheet.href?.endsWith("/themes/eva-restrained.css")));
      for (const width of widths) {
        await page.setViewportSize({ width, height: 900 });
        for (const language of languages) for (const variant of variants) {
          const measured = await page.evaluate(({ language, variant }) => {
            document.documentElement.lang = language;
            const ja = language === "ja";
            const set = (id, text) => { document.getElementById(id).textContent = text; };
            const status = {
              running: ja ? "実行中" : "Running",
              "user-paused": ja ? "一時停止" : "Paused",
              "fail-closed": ja ? "安全のため停止" : "Stopped for safety"
            }[variant.state];
            const reason = ja
              ? "送信は確認済みですが、対象ページが送信準備時と同じページであることを確認できないため停止しました。同じ指示は自動再送しません。"
              : "Delivery is confirmed, but this page could not be verified as the page on which sending was prepared. The same instruction will not be sent again automatically.";
            const code = "confirmed_delivery_document_identity_unavailable_without_automatic_resubmission";
            document.querySelector("#runCard").dataset.state = variant.state;
            document.querySelector("#statusBadge").dataset.state = variant.state;
            set("statusBadge", status);
            document.querySelector("#targetTab option").textContent = `Demonstration conversation · ${status} ${variant.completed}/${variant.total}`;
            set("progress", ja ? `手順 1/1 · 送信 ${variant.completed}/${variant.total}`
              : `Step 1/1 · Sends ${variant.completed}/${variant.total}`);
            document.querySelector("#progressBar").style.width = `${variant.completed / variant.total * 100}%`;
            set("connectionStatus", ja ? "接続状態: 対象の会話を確認しています" : "Connection: verifying the selected conversation");
            set("completionOutcome", status + " — " + reason);
            set("message", reason + "\n" + code);
            set("nextAction", ja ? "送信済みの内容と対象タブを確認してください。確認できない状態では再送しません。" : "Check the sent instruction and selected tab. Do not resend while the outcome is uncertain.");
            set("activeRunWarning", ja ? "実行中は会話の切り替え・入力欄や添付の手動編集を避けてください。" : "Avoid switching conversations or manually editing the composer or attachments while a run is active.");
            for (const [id, text] of [["pause", ja ? "一時停止" : "Pause"], ["resume", ja ? "再開" : "Resume"], ["stop", ja ? "停止" : "Stop"]]) {
              const node = document.getElementById(id); node.textContent = text;
              node.disabled = id === "pause" ? variant.state !== "running" : id === "resume" ? variant.state !== "user-paused" : false;
            }
            const card = document.querySelector("#runCard");
            const cardBox = card.getBoundingClientRect();
            const selectors = [".run-summary", ".run-status", "#statusBadge", "#progress", "#runDetails", ".progress-track", "#runGuidance", "#connectionStatus", "#completionOutcome", ".cockpit-guidance", "#message", "#nextAction", "#activeRunWarning", ".actions", "#pause", "#resume", "#stop"];
            const boxes = selectors.map(selector => {
              const node = card.querySelector(selector), box = node.getBoundingClientRect(), css = getComputedStyle(node);
              const range = document.createRange(); range.selectNodeContents(node);
              const textBox = range.getBoundingClientRect();
              return { selector, left: box.left, right: box.right, top: box.top, bottom: box.bottom,
                width: box.width, height: box.height, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth,
                display: css.display, visibility: css.visibility, overflowX: css.overflowX, fontSize: css.fontSize,
                foreground: css.color, background: css.backgroundColor,
                textLeft: textBox.left, textRight: textBox.right, textTop: textBox.top, textBottom: textBox.bottom };
            });
            const find = selector => boxes.find(box => box.selector === selector);
            const statusBox = find(".run-status"), progressBox = find("#progress");
            const overlaps = statusBox.left < progressBox.right - .5 && statusBox.right > progressBox.left + .5 &&
              statusBox.top < progressBox.bottom - .5 && statusBox.bottom > progressBox.top + .5;
            return { documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth,
              card: { left: cardBox.left, right: cardBox.right, width: cardBox.width }, boxes, overlaps,
              progressText: document.querySelector("#progress").textContent,
              bodyOverflowX: getComputedStyle(document.body).overflowX,
              rootOverflowX: getComputedStyle(document.documentElement).overflowX };
          }, { language, variant });
          const label = `${theme.id}/${mode}/${density}/${width}/${language}/${variant.state}-${variant.completed}-of-${variant.total}`;
          const problems = [];
          if (measured.documentWidth > width + 1) problems.push(`document width ${measured.documentWidth} > ${width}`);
          if (measured.overlaps) problems.push("status and progress overlap");
          for (const box of measured.boxes) {
            if (box.width <= 0 || box.height <= 0 || box.display === "none" || box.visibility === "hidden") problems.push(`${box.selector} hidden`);
            if (box.left < measured.card.left - .5 || box.right > measured.card.right + .5) problems.push(`${box.selector} outside card`);
            if (box.scrollWidth > box.clientWidth + 1) problems.push(`${box.selector} horizontal content overflow ${box.scrollWidth}/${box.clientWidth}`);
            const isButton = ["#pause", "#resume", "#stop"].includes(box.selector);
            // EVA's existing buttons clip a decorative background, not their text.
            // Check actual text geometry instead of rejecting that theme outright.
            if (isButton && (box.textLeft < box.left - .5 || box.textRight > box.right + .5 ||
                box.textTop < box.top - .5 || box.textBottom > box.bottom + .5)) problems.push(`${box.selector} text clipped`);
            if (isButton && box.foreground === box.background) problems.push(`${box.selector} text matches its background`);
            if (!isButton && box.selector !== ".progress-track" && ["hidden", "clip"].includes(box.overflowX)) problems.push(`${box.selector} clipped to hide overflow`);
          }
          if ([measured.bodyOverflowX, measured.rootOverflowX].some(value => ["hidden", "clip"].includes(value))) problems.push("page clips horizontal overflow");
          results.push({ label, ...variant, width, language, problems, ...(problems.length ? { measured } : {}) });
          if ((problems.length && screenshots.length < 3) || (!quick && mode === modes[0] && density === "comfortable" && width === 320 && language === "ja" && variant.state === "fail-closed" && variant.completed === 50)) {
            const filename = label.replaceAll("/", "-") + ".png";
            await page.screenshot({ path: path.join(evidence, filename), fullPage: true });
            screenshots.push(filename);
          }
        }
      }
    }
  }
  const failed = results.filter(result => result.problems.length);
  const summary = { phase, baselineCss: baselineCss !== null, kind: "offline production markup/CSS/theme with synthetic Run presentation",
    themeCount: themes.length, widths, densities, languages, total: results.length, passed: results.length - failed.length,
    failed: failed.length, errors, blockedRequests, screenshots, evidenceDirectory: evidence };
  fs.writeFileSync(path.join(evidence, "results.json"), JSON.stringify({ summary, results }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  for (const result of failed.slice(0, 5)) console.log(`FAIL ${result.label}: ${result.problems.join("; ")}`);
  assert.equal(errors.length, 0, "page errors");
  assert.equal(blockedRequests.length, 0, "unexpected request");
  assert.equal(failed.length, 0, `${failed.length} layout combinations failed`);
} finally {
  await browser.close();
}
