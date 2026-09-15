// Inspection candidate only. This tool cannot certify manual live acceptance.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const EXCLUDED = /(?:^|\/)(?:\.git|\.github|node_modules|tests?|docs|research|evals|coverage|screenshots|profiles|traces|logs|scratch|scripts)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|\.(?:map|log|zip|pem|key)$/i;
const ASSET_EXTENSION = /\.(?:js|css|html|json|svg|png|jpe?g|webp|gif|ico|woff2?|ttf|otf)$/i;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function localReference(from, reference, root = false) {
  if (/^(?:https?:|data:|blob:|#)/i.test(reference)) return null;
  if (!reference || /^(?:[a-z][\w+.-]*:|\/|\\)/i.test(reference) || reference.includes("\\")) {
    throw new Error(`Unsupported or absolute asset reference in ${from}: ${reference}`);
  }
  const file = path.posix.normalize(path.posix.join(root ? "." : path.posix.dirname(from), reference.split(/[?#]/)[0]));
  if (file === ".." || file.startsWith("../") || EXCLUDED.test(file) || !ASSET_EXTENSION.test(file)) {
    throw new Error(`Disallowed runtime asset in ${from}: ${file}`);
  }
  return file;
}

// Follow the static reference forms used by this extension. This is not a
// general JS bundler: a new dynamic asset-loading convention needs review here.
export function collectRuntimeFiles(manifest, availablePaths, read) {
  const available = new Set(availablePaths);
  const selected = new Set(["manifest.json"]);
  const queue = [];
  const add = (from, reference, root = false) => {
    const file = localReference(from, reference, root);
    if (file === null) return;
    if (!available.has(file)) throw new Error(`Missing runtime asset: ${file} (from ${from})`);
    if (!selected.has(file)) { selected.add(file); queue.push(file); }
  };
  const roots = [manifest.background?.service_worker, ...(manifest.background?.scripts ?? []),
    manifest.side_panel?.default_path, manifest.options_ui?.page, manifest.options_page,
    manifest.action?.default_popup, ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.chrome_url_overrides ?? {})];
  const actionIcon = manifest.action?.default_icon;
  if (typeof actionIcon === "string") roots.push(actionIcon);
  else roots.push(...Object.values(actionIcon ?? {}));
  for (const content of manifest.content_scripts ?? []) roots.push(...(content.js ?? []), ...(content.css ?? []));
  for (const resources of manifest.web_accessible_resources ?? []) roots.push(...resources.resources);
  for (const root of roots.filter(Boolean)) add("manifest.json", root, true);

  const locales = availablePaths.filter((file) => /^_locales\/[^/]+\/messages\.json$/.test(file));
  for (const required of [manifest.default_locale, "ja", "en"]) {
    if (!required || !locales.includes(`_locales/${required}/messages.json`)) throw new Error(`Missing locale: ${required}`);
  }
  const messageKeys = [...JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)].map((match) => match[1]);
  for (const file of locales) {
    const messages = JSON.parse(read(file).toString("utf8"));
    for (const key of messageKeys) {
      if (typeof messages[key]?.message !== "string" || !messages[key].message.trim()) {
        throw new Error(`Missing manifest message ${key} in ${file}`);
      }
    }
    add("manifest.json", file, true);
  }
  while (queue.length) {
    const file = queue.shift();
    if (!/\.(?:html|js|css)$/.test(file)) continue;
    const text = read(file).toString("utf8");
    if (file.endsWith(".html")) {
      for (const match of text.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/g)) add(file, match[1]);
    } else if (file.endsWith(".css")) {
      for (const match of text.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)|@import\s+["']([^"']+)["']/g)) add(file, match[1] ?? match[2]);
    } else {
      for (const pattern of [
        /\b(?:import|export)\s+(?:\{[^}]*\}|[\w$*]+(?:\s+as\s+[\w$]+)?)(?:\s*,\s*\{[^}]*\})?\s+from\s*["']([^"']+)["']/g,
        /\bimport\s*["']([^"']+)["']/g,
        /\bimport\(\s*["']([^"']+)["']\s*\)/g
      ]) {
        for (const match of text.matchAll(pattern)) {
          if (!match[1].startsWith(".")) throw new Error(`Non-local JS import in ${file}: ${match[1]}`);
          add(file, match[1]);
        }
      }
      for (const match of text.matchAll(/\bnew URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g)) add(file, match[1]);
      for (const match of text.matchAll(/\bruntime\.getURL\(\s*["']([^"']+)["']\s*\)/g)) add(file, match[1], true);
    }
  }
  return [...selected].sort();
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ZIP32, deflate, UTF-8 filenames, fixed DOS date (1980-01-01). No filesystem
// timestamps, absolute paths, platform attributes or generated notes enter ZIP.
function zipFiles(files, read) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file);
    const bytes = read(file);
    const compressed = deflateRawSync(bytes, { level: 9 });
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(33, 12);
    local.writeUInt32LE(crc32(bytes), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    local.copy(central, 6, 4, 30);
    central.writeUInt32LE(offset, 42);
    localParts.push(local, name, compressed);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, directory, end]);
}

export function buildCandidate({ repoRoot, commit, outDir }) {
  const git = (...args) => execFileSync("git", ["-C", repoRoot, ...args], { maxBuffer: 16 * 1024 * 1024 });
  if (!/^[a-f0-9]{40}$/.test(commit ?? "") || git("rev-parse", "HEAD").toString().trim() !== commit) {
    throw new Error("--commit must be the explicit full SHA of the current HEAD");
  }
  if (git("status", "--porcelain=v1", "--untracked-files=all").length) throw new Error("Candidate working tree must be clean");
  const output = path.resolve(outDir ?? path.join(os.tmpdir(), "aipm-edge-store-candidates", commit));
  const relative = path.relative(fs.realpathSync(repoRoot), output);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error("Choose an output directory outside the repository");
  }
  const tree = new Map(git("ls-tree", "-r", "-z", commit).toString().split("\0").filter(Boolean).map((line) => {
    const [metadata, file] = line.split("\t");
    return [file, metadata.split(" ")[0]];
  }));
  const blobs = new Map();
  const read = (file) => {
    if (!/^100(?:644|755)$/.test(tree.get(file) ?? "")) throw new Error(`Not a tracked regular file: ${file}`);
    if (!blobs.has(file)) blobs.set(file, git("show", `${commit}:${file}`));
    return blobs.get(file);
  };
  const manifest = JSON.parse(read("manifest.json").toString());
  const version = manifest.version;
  if (typeof version !== "string" || !/^\d+(?:\.\d+){0,3}$/.test(version) ||
      version.split(".").some((part) => Number(part) > 65535 || (part.length > 1 && part.startsWith("0")))) {
    throw new Error("Invalid numeric extension version");
  }
  const metadata = JSON.parse(read("package.json").toString());
  const lock = JSON.parse(read("package-lock.json").toString());
  const markers = [...read("src/content-core.js").toString().matchAll(/__AIPM_CONTENT_CORE__\s*=\s*\{\s*version:\s*"([^"]+)"/g)];
  if (metadata.version !== version || lock.version !== version || lock.packages?.[""]?.version !== version ||
      markers.length !== 2 || markers.some((match) => match[1] !== version) ||
      !read("src/sidepanel.html").toString().includes(`AI Prompt Macro · ${version}`)) {
    throw new Error("Manifest/package/lock/content/UI versions are inconsistent");
  }
  const files = collectRuntimeFiles(manifest, [...tree.keys()], read);
  if (new Set(files.map((file) => file.toLowerCase())).size !== files.length) throw new Error("Case-colliding package paths");
  for (const file of files) {
    if (EXCLUDED.test(file)) throw new Error(`Excluded package path: ${file}`);
    if (!/\.(?:js|css|html|json|svg)$/.test(file)) continue;
    const text = read(file).toString();
    if (/[A-Za-z]:[\\/](?:Users|Documents and Settings|home)[\\/]|\/(?:Users|home)\/[\w.-]+\//.test(text)) {
      throw new Error(`Local absolute path in ${file}`);
    }
    if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/.test(text)) {
      throw new Error(`Credential-like content in ${file}`);
    }
  }
  const zip = zipFiles(files, read);
  const stem = `ai-prompt-macro-edge-${version}`;
  const record = {
    status: "NOT FOR STORE UPLOAD", sourceCommit: commit, manifestVersion: version,
    filename: `${stem}.zip`, sha256: sha256(zip), sizeBytes: zip.length,
    included: files.map((file) => ({ path: file, sizeBytes: read(file).length, sha256: sha256(read(file)) })),
    excluded: [...tree.keys()].filter((file) => !files.includes(file)).sort(),
    generatedAt: new Date().toISOString(), generatedBy: "scripts/build-edge-store-package.mjs",
    nodeVersion: process.version, liveAcceptance: "MANUAL CHECK REQUIRED"
  };
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, record.filename), zip);
  fs.writeFileSync(path.join(output, `${stem}.build.json`), JSON.stringify(record, null, 2) + "\n");
  fs.writeFileSync(path.join(output, `${stem}.contents.txt`), files.join("\n") + "\n");
  fs.writeFileSync(path.join(output, `${stem}.sha256`), `${record.sha256}  ${record.filename}\n`);
  return { output, record };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length % 2 || args.some((arg, index) => index % 2 === 0 && !["--commit", "--out-dir"].includes(arg))) {
      throw new Error("Usage: node scripts/build-edge-store-package.mjs --commit <full-SHA> [--out-dir <external-directory>]");
    }
    const options = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, i) => [args[i * 2], args[i * 2 + 1]]));
    const result = buildCandidate({ repoRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
      commit: options["--commit"], outDir: options["--out-dir"] });
    console.log(result.record.status);
    console.log(result.record.included.map((file) => file.path).join("\n"));
    console.log(JSON.stringify({ output: result.output, sourceCommit: result.record.sourceCommit,
      filename: result.record.filename, sha256: result.record.sha256, sizeBytes: result.record.sizeBytes }, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
