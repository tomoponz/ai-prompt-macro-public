import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { inflateRawSync, crc32 } from "node:zlib";
import { buildCandidate, collectRuntimeFiles } from "../scripts/build-edge-store-package.mjs";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aipm-package-test-"));
  t.after(() => {
    assert.equal(path.dirname(directory), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("aipm-package-test-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const repoRoot = path.join(directory, "repo");
  fs.mkdirSync(repoRoot);
  const write = (file, value) => {
    const destination = path.join(repoRoot, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, typeof value === "object" ? JSON.stringify(value) : value);
  };
  const manifest = { manifest_version: 3, version: "0.4.0", name: "__MSG_name__", default_locale: "ja",
    background: { service_worker: "src/background.js", type: "module" },
    side_panel: { default_path: "src/sidepanel.html" },
    content_scripts: [{ matches: ["https://chatgpt.com/*"], js: ["src/content-core.js"] }] };
  const files = {
    "manifest.json": manifest,
    "package.json": { version: "0.4.0" },
    "package-lock.json": { version: "0.4.0", packages: { "": { version: "0.4.0" } } },
    "_locales/ja/messages.json": { name: { message: "テスト" } },
    "_locales/en/messages.json": { name: { message: "Test" } },
    "src/background.js": 'import "./shared.js"; chrome.runtime.getURL("src/workspace.html");',
    "src/shared.js": 'export const value = 1;',
    "src/content-core.js": 'globalThis.__AIPM_CONTENT_CORE__ = { version: "0.4.0", ready: false };\nglobalThis.__AIPM_CONTENT_CORE__ = { version: "0.4.0", ready: true };',
    "src/sidepanel.html": '<h1>AI Prompt Macro · 0.4.0</h1><script type="module" src="panel.js"></script>',
    "src/panel.js": 'import { value } from "./shared.js"; new URL("./theme.css", import.meta.url);',
    "src/theme.css": '@import "./base.css"; body { background: url("./icon.svg"); }',
    "src/base.css": 'body { color: black; }',
    "src/icon.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>',
    "src/workspace.html": '<link href="theme.css" rel="stylesheet">',
    "src/unreferenced.js": 'throw new Error("must not be packaged");',
    "docs/note.md": "not runtime", "tests/secret.txt": "not runtime"
  };
  for (const [file, value] of Object.entries(files)) write(file, value);
  const git = (...args) => execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init");
  git("config", "core.autocrlf", "false");
  const commit = () => {
    git("add", ".");
    git("-c", "user.name=Package test", "-c", "user.email=package-test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
    return git("rev-parse", "HEAD");
  };
  return { directory, repoRoot, write, manifest, files, commit, read: (file) => fs.readFileSync(path.join(repoRoot, file)) };
}

// Read the central directory independently of the writer, inflate every member,
// and use zlib's CRC implementation to verify actual ZIP data and offsets.
function unpack(zip) {
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  let position = zip.readUInt32LE(end + 16);
  const files = new Map();
  for (let i = 0; i < count; i += 1) {
    assert.equal(zip.readUInt32LE(position), 0x02014b50);
    const size = zip.readUInt32LE(position + 20);
    const nameLength = zip.readUInt16LE(position + 28);
    const extraLength = zip.readUInt16LE(position + 30);
    const commentLength = zip.readUInt16LE(position + 32);
    const name = zip.subarray(position + 46, position + 46 + nameLength).toString();
    const local = zip.readUInt32LE(position + 42);
    assert.equal(zip.readUInt32LE(local), 0x04034b50);
    assert.equal(zip.readUInt16LE(local + 8), 8);
    const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const bytes = inflateRawSync(zip.subarray(dataStart, dataStart + size));
    assert.equal(bytes.length, zip.readUInt32LE(position + 24));
    assert.equal(crc32(bytes), zip.readUInt32LE(position + 16));
    assert.ok(!files.has(name));
    files.set(name, bytes);
    position += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(position, end);
  return files;
}

test("candidate ZIP uses clean exact Git bytes, resolves dependencies and is reproducible", (t) => {
  const f = fixture(t);
  const commit = f.commit();
  const first = buildCandidate({ repoRoot: f.repoRoot, commit, outDir: path.join(f.directory, "first") });
  const second = buildCandidate({ repoRoot: f.repoRoot, commit, outDir: path.join(f.directory, "second") });
  const zip = fs.readFileSync(path.join(first.output, first.record.filename));
  assert.deepEqual(zip, fs.readFileSync(path.join(second.output, second.record.filename)));
  assert.equal(first.record.sourceCommit, commit);
  assert.equal(first.record.status, "NOT FOR STORE UPLOAD");
  assert.equal(first.record.sha256, second.record.sha256);
  const unpacked = unpack(zip);
  const expected = Object.keys(f.files).filter((file) => !["package.json", "package-lock.json", "src/unreferenced.js", "docs/note.md", "tests/secret.txt"].includes(file)).sort();
  assert.deepEqual([...unpacked.keys()], expected);
  assert.deepEqual(first.record.included.map((file) => file.path), expected);
  for (const [file, bytes] of unpacked) assert.deepEqual(bytes, f.read(file), file);
  assert.equal(JSON.parse(unpacked.get("manifest.json")).version, "0.4.0");
});

test("builder rejects wrong SHA, dirty tracked/untracked files and repository output", (t) => {
  const f = fixture(t);
  const commit = f.commit();
  const build = (extra = {}) => buildCandidate({ repoRoot: f.repoRoot, commit, outDir: path.join(f.directory, "output"), ...extra });
  assert.throws(() => build({ commit: "0".repeat(40) }), /explicit full SHA/);
  assert.throws(() => build({ outDir: path.join(f.repoRoot, "dist") }), /outside the repository/);
  f.write("new.txt", "untracked");
  assert.throws(() => build(), /must be clean/);
  fs.unlinkSync(path.join(f.repoRoot, "new.txt"));
  f.write("src/shared.js", "modified");
  assert.throws(() => build(), /must be clean/);
  assert.equal(fs.existsSync(path.join(f.directory, "output")), false);
});

test("missing assets/locales and escaping or external JS imports fail closed", (t) => {
  const f = fixture(t);
  const paths = Object.keys(f.files);
  for (const missing of ["src/shared.js", "src/theme.css", "src/icon.svg", "_locales/ja/messages.json", "_locales/en/messages.json"]) {
    assert.throws(() => collectRuntimeFiles(f.manifest, paths.filter((file) => file !== missing), f.read), /Missing/);
  }
  f.write("src/panel.js", 'import "../../outside.js";');
  assert.throws(() => collectRuntimeFiles(f.manifest, paths, f.read), /Disallowed runtime asset/);
  f.write("src/panel.js", 'import "https://example.invalid/code.js";');
  assert.throws(() => collectRuntimeFiles(f.manifest, paths, f.read), /Non-local JS import/);
});

test("clean but inconsistent version metadata cannot produce a candidate", (t) => {
  const f = fixture(t);
  f.write("package.json", { version: "0.2.0" });
  const commit = f.commit();
  assert.throws(() => buildCandidate({ repoRoot: f.repoRoot, commit, outDir: path.join(f.directory, "output") }), /versions are inconsistent/);
});

test("current production dependency graph contains locales, navigation and theme assets", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const paths = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" }).split("\0").filter(Boolean);
  const read = (file) => fs.readFileSync(path.join(repoRoot, file));
  const files = collectRuntimeFiles(JSON.parse(read("manifest.json")), paths, read);
  for (const required of ["manifest.json", "_locales/ja/messages.json", "_locales/en/messages.json", "src/workspace.html",
    "src/themes/fidelity.css", "src/themes/manual-ux.css", "src/dev-update.js"]) assert.ok(files.includes(required), required);
  assert.ok(files.every((file) => file === "manifest.json" || file.startsWith("src/") || file.startsWith("_locales/")));
});
