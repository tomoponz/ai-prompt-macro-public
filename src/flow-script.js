import {
  DEFAULT_LATE_GRACE_MS,
  MAX_SENDS_PER_RUN,
  MAX_WAIT_MS,
  MAX_WORKFLOW_BLOCKS
} from "./workflow.js";

export const AIPM_FLOW_VERSION = "1.1";
export const MAX_FLOW_TEXT_BYTES = 64 * 1024;
export const MAX_FLOW_NESTING = 3;
export const MAX_FLOW_REPEAT_COUNT = MAX_SENDS_PER_RUN;
export const MAX_FLOW_ERROR_TOKEN_CHARS = 80;

export class AipmFlowError extends Error {
  constructor(code, message, source, offset = 0) {
    const position = locate(source, offset);
    super(`${message} (${position.line}行${position.column}列)`);
    this.name = "AipmFlowError";
    this.code = code;
    this.offset = position.offset;
    this.line = position.line;
    this.column = position.column;
  }
}

export function parseAipmFlow(text) {
  if (typeof text !== "string") {
    throw new AipmFlowError("INVALID_INPUT", "AIPM Flowはテキストで入力してください。", "", 0);
  }

  if (utf8ByteLength(text) > MAX_FLOW_TEXT_BYTES) {
    throw new AipmFlowError(
      "INPUT_TOO_LARGE",
      `AIPM Flowが大きすぎます。${MAX_FLOW_TEXT_BYTES} bytes以下にしてください。`,
      text,
      0
    );
  }

  const parser = new Parser(text);
  const flows = parser.parseDocument();
  const seenNames = new Set();

  for (const flow of flows) {
    const key = flow.name.toLowerCase();
    if (seenNames.has(key)) {
      throw new AipmFlowError(
        "DUPLICATE_FLOW_NAME",
        `Flow名「${boundedErrorToken(flow.name)}」が重複しています。`,
        text,
        flow.nameOffset
      );
    }
    seenNames.add(key);

    const plannedSends = countNodeSends(flow.steps, text, flow.nameOffset);
    if (plannedSends > MAX_SENDS_PER_RUN) {
      throw new AipmFlowError(
        "TOO_MANY_SENDS",
        `Flow「${boundedErrorToken(flow.name)}」は${plannedSends}回送信予定です。上限は${MAX_SENDS_PER_RUN}回です。`,
        text,
        flow.nameOffset
      );
    }

    const plannedNonSendActions = countNodeNonSendActions(flow.steps, text, flow.nameOffset);
    if (plannedNonSendActions > MAX_WORKFLOW_BLOCKS) {
      throw new AipmFlowError(
        "TOO_MANY_ACTIONS",
        `Flow「${boundedErrorToken(flow.name)}」は展開すると非送信actionsが${plannedNonSendActions}件になります。上限は${MAX_WORKFLOW_BLOCKS}件です。`,
        text,
        flow.nameOffset
      );
    }

    flow.plannedSends = plannedSends;
    flow.plannedActions = plannedSends + plannedNonSendActions;
    delete flow.nameOffset;
  }

  return {
    version: AIPM_FLOW_VERSION,
    flows
  };
}

class Parser {
  constructor(source) {
    this.source = source;
    this.index = 0;
  }

  parseDocument() {
    const flows = [];
    this.skipWhitespace();

    while (!this.eof()) {
      if (!this.isKeyword("flow")) {
        this.fail("EXPECTED_FLOW", "ここでは `flow <name> { ... }` が必要です。");
      }
      flows.push(this.parseFlow());
      this.skipWhitespace();
    }

    if (flows.length === 0) {
      this.fail("EMPTY_DOCUMENT", "AIPM Flowを1つ以上入力してください。", 0);
    }
    return flows;
  }

  parseFlow() {
    this.consumeKeyword("flow");
    this.requireWhitespace("`flow` の後にFlow名を指定してください。");
    this.skipWhitespace();

    const nameOffset = this.index;
    const name = this.readIdentifier();
    if (!name) this.fail("INVALID_FLOW_NAME", "Flow名が不正です。英数字、`_`、`-`を使用してください。", nameOffset);

    this.skipWhitespace();
    this.expectChar("{", "Flow名の後に `{` が必要です。");
    const steps = this.parseStatements(0, "flow");

    if (steps.length === 0) {
      this.fail("EMPTY_FLOW", `Flow「${boundedErrorToken(name)}」に1つ以上のcommandを入れてください。`, nameOffset);
    }

    return { name, nameOffset, steps };
  }

  parseStatements(depth, owner) {
    const steps = [];

    while (true) {
      this.skipWhitespace();
      if (this.eof()) {
        this.fail("UNCLOSED_BLOCK", `${owner} blockの閉じ括弧 \`}\` がありません。`);
      }
      if (this.peek() === "}") {
        this.index += 1;
        return steps;
      }
      steps.push(this.parseStatement(depth));
    }
  }

  parseStatement(depth) {
    if (this.isKeyword("send")) return this.parseSend();
    if (this.isKeyword("repeat")) return this.parseRepeat(depth);
    if (this.isKeyword("checkpoint")) return this.parseCheckpoint();
    if (this.isKeyword("wait")) return this.parseWait();

    const start = this.index;
    const command = this.readCommandToken();
    this.fail(
      "UNKNOWN_COMMAND",
      command ? `未対応のcommand「${boundedErrorToken(command)}」です。` : "commandを読み取れません。",
      start
    );
  }

  parseSend() {
    const start = this.index;
    this.consumeKeyword("send");
    this.requireWhitespace("`send` の後に `\"\"\"` で囲んだPromptが必要です。");
    this.skipWhitespace();

    if (!this.source.startsWith('"""', this.index)) {
      this.fail("EXPECTED_MULTILINE_STRING", '`send` は `"""..."""` 形式で指定してください。', this.index);
    }
    this.index += 3;
    const promptOffset = this.index;
    const end = this.source.indexOf('"""', this.index);
    if (end === -1) {
      this.fail("UNTERMINATED_STRING", 'Promptを閉じる `"""` がありません。', promptOffset);
    }

    const prompt = dedentFlowPrompt(this.source.slice(this.index, end));
    this.index = end + 3;
    if (!prompt.trim()) {
      this.fail("EMPTY_PROMPT", "空のPromptは送信できません。", start);
    }

    return {
      type: "send",
      prompt,
      offset: start
    };
  }

  parseCheckpoint() {
    const start = this.index;
    this.consumeKeyword("checkpoint");
    this.requireWhitespace('`checkpoint` の後に `"..."` で囲んだラベルが必要です。');
    this.skipWhitespace();

    const label = this.readQuotedString("Checkpointラベル");
    if (!label.trim()) {
      this.fail("EMPTY_CHECKPOINT", "Checkpointラベルを空にはできません。", start);
    }

    return {
      type: "checkpoint",
      label,
      offset: start
    };
  }

  parseWait() {
    const start = this.index;
    this.consumeKeyword("wait");
    this.requireWhitespace("`wait` の後に期間、または `until` と指定時刻が必要です。");
    this.skipWhitespace();

    if (this.isKeyword("until")) return this.parseWaitUntil(start);

    const durationOffset = this.index;
    const rawDuration = this.readValueToken();
    const durationMs = parseDurationMs(rawDuration, {
      allowZero: false,
      source: this.source,
      offset: durationOffset,
      label: "wait期間"
    });

    return {
      type: "wait",
      durationMs,
      offset: start
    };
  }

  parseWaitUntil(start) {
    this.consumeKeyword("until");
    this.requireWhitespace('`wait until` の後にタイムゾーン付きの `"..."` 時刻が必要です。');
    this.skipWhitespace();

    const atOffset = this.index;
    const rawAt = this.readQuotedString("指定時刻");
    const at = normalizeExplicitIsoTimestamp(rawAt, this.source, atOffset);
    let latePolicy = "pause";
    let graceMs = DEFAULT_LATE_GRACE_MS;
    let sawLate = false;
    let sawGrace = false;

    while (true) {
      const optionOffset = this.index;
      this.skipWhitespace();

      if (this.isKeyword("late")) {
        if (sawLate) this.fail("DUPLICATE_WAIT_OPTION", "late policyが重複しています。", optionOffset);
        sawLate = true;
        this.consumeKeyword("late");
        this.requireWhitespace("`late` の後に pause / run / skip を指定してください。");
        this.skipWhitespace();
        const policyOffset = this.index;
        const rawPolicy = this.readValueToken();
        if (!["pause", "run", "skip"].includes(rawPolicy)) {
          this.fail("INVALID_LATE_POLICY", "late policyは pause / run / skip のいずれかです。", policyOffset);
        }
        latePolicy = rawPolicy;
        continue;
      }

      if (this.isKeyword("grace")) {
        if (sawGrace) this.fail("DUPLICATE_WAIT_OPTION", "graceが重複しています。", optionOffset);
        sawGrace = true;
        this.consumeKeyword("grace");
        this.requireWhitespace("`grace` の後に有限の期間が必要です。");
        this.skipWhitespace();
        const graceOffset = this.index;
        graceMs = parseDurationMs(this.readValueToken(), {
          allowZero: true,
          source: this.source,
          offset: graceOffset,
          label: "grace"
        });
        continue;
      }

      this.index = optionOffset;
      break;
    }

    return {
      type: "wait-until",
      at,
      latePolicy,
      graceMs,
      offset: start
    };
  }

  parseRepeat(depth) {
    const start = this.index;
    this.consumeKeyword("repeat");
    this.requireWhitespace("`repeat` の後に有限の正整数が必要です。");
    this.skipWhitespace();

    const countOffset = this.index;
    const rawCount = this.readValueToken();
    if (!/^[0-9]+$/.test(rawCount)) {
      this.fail("INVALID_REPEAT", "repeat回数は有限の正整数で指定してください。", countOffset);
    }

    const countBig = BigInt(rawCount);
    if (countBig <= 0n) {
      this.fail("INVALID_REPEAT", "repeat回数は1以上で指定してください。", countOffset);
    }

    this.skipWhitespace();
    this.expectChar("{", "repeat回数の後に `{` が必要です。");

    const nextDepth = depth + 1;
    if (nextDepth > MAX_FLOW_NESTING) {
      this.fail(
        "EXCESSIVE_NESTING",
        `repeatの入れ子は${MAX_FLOW_NESTING}段までです。`,
        start
      );
    }

    const steps = this.parseStatements(nextDepth, "repeat");
    if (steps.length === 0) {
      this.fail("EMPTY_REPEAT", "repeat blockに1つ以上のcommandを入れてください。", start);
    }

    const childSends = countNodeSends(steps, this.source, start);
    const plannedBig = BigInt(childSends) * countBig;
    if (plannedBig > BigInt(MAX_SENDS_PER_RUN)) {
      this.fail(
        "TOO_MANY_SENDS",
        `repeatを展開すると送信予定数が${MAX_SENDS_PER_RUN}回を超えます。`,
        countOffset
      );
    }
    if (countBig > BigInt(MAX_FLOW_REPEAT_COUNT)) {
      this.fail(
        "INVALID_REPEAT",
        `repeat回数は${MAX_FLOW_REPEAT_COUNT}以下で指定してください。`,
        countOffset
      );
    }

    const childNonSendActions = countNodeNonSendActions(steps, this.source, start);
    const plannedNonSendActionsBig = BigInt(childNonSendActions) * countBig;
    if (plannedNonSendActionsBig > BigInt(MAX_WORKFLOW_BLOCKS)) {
      this.fail(
        "TOO_MANY_ACTIONS",
        `repeatを展開すると非送信actionsが${MAX_WORKFLOW_BLOCKS}件を超えます。`,
        countOffset
      );
    }

    return {
      type: "repeat",
      count: Number(countBig),
      steps,
      offset: start
    };
  }

  readQuotedString(label) {
    const start = this.index;
    if (this.peek() !== '"') {
      this.fail("EXPECTED_STRING", `${label}は \"...\" 形式で指定してください。`, start);
    }
    this.index += 1;
    let value = "";

    while (!this.eof()) {
      const char = this.source[this.index];
      this.index += 1;

      if (char === '"') return value;
      if (char === "\n" || char === "\r") {
        this.fail("UNTERMINATED_STRING", `${label}は1行で指定し、閉じる \" が必要です。`, this.index - 1);
      }
      if (char === "\\") {
        if (this.eof()) {
          this.fail("UNTERMINATED_STRING", `${label}を閉じる \" がありません。`, start);
        }
        const escaped = this.source[this.index];
        this.index += 1;
        if (escaped !== '"' && escaped !== "\\") {
          this.fail("INVALID_ESCAPE", `${label}で使用できるescapeは \\" と \\\\ だけです。`, this.index - 2);
        }
        value += escaped;
        continue;
      }
      value += char;
    }

    this.fail("UNTERMINATED_STRING", `${label}を閉じる \" がありません。`, start);
  }

  isKeyword(keyword) {
    if (!this.source.startsWith(keyword, this.index)) return false;
    const next = this.source[this.index + keyword.length];
    return next === undefined || /\s|\{/.test(next);
  }

  consumeKeyword(keyword) {
    this.index += keyword.length;
  }

  readIdentifier() {
    const match = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(this.source.slice(this.index));
    if (!match) return "";
    this.index += match[0].length;
    return match[0];
  }

  readCommandToken() {
    const match = /^[^\s{}]+/.exec(this.source.slice(this.index));
    if (!match) return "";
    this.index += match[0].length;
    return match[0];
  }

  readValueToken() {
    const match = /^[^\s{}]+/.exec(this.source.slice(this.index));
    if (!match) return "";
    this.index += match[0].length;
    return match[0];
  }

  requireWhitespace(message) {
    if (this.eof() || !/\s/.test(this.peek())) {
      this.fail("EXPECTED_WHITESPACE", message);
    }
  }

  skipWhitespace() {
    while (!this.eof()) {
      if (/\s/.test(this.peek())) {
        this.index += 1;
        continue;
      }
      if (this.peek() === "#") {
        while (!this.eof() && this.peek() !== "\n" && this.peek() !== "\r") this.index += 1;
        continue;
      }
      break;
    }
  }

  expectChar(char, message) {
    if (this.peek() !== char) this.fail("EXPECTED_TOKEN", message);
    this.index += 1;
  }

  peek() {
    return this.source[this.index];
  }

  eof() {
    return this.index >= this.source.length;
  }

  fail(code, message, offset = this.index) {
    throw new AipmFlowError(code, message, this.source, offset);
  }
}

function countNodeSends(steps, source, offset) {
  let total = 0n;

  for (const step of steps) {
    if (step.type === "send") {
      total += 1n;
    } else if (["checkpoint", "wait", "wait-until"].includes(step.type)) {
      continue;
    } else if (step.type === "repeat") {
      total += BigInt(step.count) * BigInt(countNodeSends(step.steps, source, step.offset));
    } else {
      throw new AipmFlowError("INVALID_AST", "内部Flow構造が不正です。", source, offset);
    }

    if (total > BigInt(MAX_SENDS_PER_RUN)) {
      return MAX_SENDS_PER_RUN + 1;
    }
  }

  return Number(total);
}

function countNodeNonSendActions(steps, source, offset) {
  let total = 0n;

  for (const step of steps) {
    if (step.type === "send") {
      continue;
    } else if (["checkpoint", "wait", "wait-until"].includes(step.type)) {
      total += 1n;
    } else if (step.type === "repeat") {
      total += BigInt(step.count) * BigInt(countNodeNonSendActions(step.steps, source, step.offset));
    } else {
      throw new AipmFlowError("INVALID_AST", "内部Flow構造が不正です。", source, offset);
    }

    if (total > BigInt(MAX_WORKFLOW_BLOCKS)) {
      return MAX_WORKFLOW_BLOCKS + 1;
    }
  }

  return Number(total);
}

function parseDurationMs(rawValue, { allowZero, source, offset, label }) {
  const raw = String(rawValue ?? "");
  const match = /^([0-9]+)(ms|s|m|h)$/.exec(raw);
  if (!match) {
    throw new AipmFlowError(
      "INVALID_DURATION",
      `${label}は 500ms / 30s / 5m / 1h のような有限の整数で指定してください。`,
      source,
      offset
    );
  }

  const value = BigInt(match[1]);
  const multiplier = {
    ms: 1n,
    s: 1000n,
    m: 60_000n,
    h: 3_600_000n
  }[match[2]];
  const durationMs = value * multiplier;

  if ((!allowZero && durationMs === 0n) || durationMs > BigInt(MAX_WAIT_MS)) {
    throw new AipmFlowError(
      "INVALID_DURATION",
      `${label}は${allowZero ? "0以上" : "0より大きく"}、最大24hで指定してください。`,
      source,
      offset
    );
  }

  return Number(durationMs);
}

function normalizeExplicitIsoTimestamp(rawValue, source, offset) {
  const raw = String(rawValue ?? "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(raw);
  if (!match) {
    throw new AipmFlowError(
      "INVALID_TIMESTAMP",
      "指定時刻は 2026-08-25T09:00:00+09:00 のようにタイムゾーンを明示してください。",
      source,
      offset
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? 0);
  const millisecond = Number((match[7] ?? "").padEnd(3, "0"));
  const calendarProbe = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
  const calendarValid =
    calendarProbe.getUTCFullYear() === year &&
    calendarProbe.getUTCMonth() === month - 1 &&
    calendarProbe.getUTCDate() === day &&
    calendarProbe.getUTCHours() === hour &&
    calendarProbe.getUTCMinutes() === minute &&
    calendarProbe.getUTCSeconds() === second;

  const offsetHour = Number(match[10] ?? 0);
  const offsetMinute = Number(match[11] ?? 0);
  if (!calendarValid || offsetHour > 23 || offsetMinute > 59) {
    throw new AipmFlowError("INVALID_TIMESTAMP", "指定時刻が不正です。", source, offset);
  }

  let timestamp = calendarProbe.getTime();
  if (match[8] !== "Z") {
    const direction = match[9] === "+" ? 1 : -1;
    timestamp -= direction * ((offsetHour * 60) + offsetMinute) * 60_000;
  }
  if (!Number.isFinite(timestamp)) {
    throw new AipmFlowError("INVALID_TIMESTAMP", "指定時刻が不正です。", source, offset);
  }
  return new Date(timestamp).toISOString();
}

function utf8ByteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

export function dedentFlowPrompt(value) {
  const lines = String(value ?? "").replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (lines.length === 0) return "";

  const indents = lines
    .filter((line) => line.trim())
    .map((line) => /^[\t ]*/.exec(line)?.[0] ?? "");
  let commonIndent = indents[0] ?? "";
  for (const indent of indents.slice(1)) {
    while (commonIndent && !indent.startsWith(commonIndent)) commonIndent = commonIndent.slice(0, -1);
  }

  return lines
    .map((line) => line.trim() ? line.slice(commonIndent.length) : "")
    .join("\n");
}

function boundedErrorToken(value) {
  const token = String(value ?? "");
  return token.length <= MAX_FLOW_ERROR_TOKEN_CHARS
    ? token
    : `${token.slice(0, MAX_FLOW_ERROR_TOKEN_CHARS)}…`;
}

function locate(source, offset) {
  const safeOffset = Math.max(0, Math.min(Number(offset) || 0, source.length));
  const before = source.slice(0, safeOffset);
  const lines = before.split("\n");
  return {
    offset: safeOffset,
    line: lines.length,
    column: lines[lines.length - 1].length + 1
  };
}
