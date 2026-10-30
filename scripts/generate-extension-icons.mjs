import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

// Original square-pixel lettering. No font, image library, or network required.
// Regenerate: node scripts/generate-extension-icons.mjs
// Verify:    node scripts/generate-extension-icons.mjs --check
// Preview:   node scripts/generate-extension-icons.mjs --preview=<directory>
// The compact A/P glyphs preserve all three letters on the 16/32px grid.
const compact = [
  ["010", "101", "101", "111", "101", "101", "101"],
  ["110", "101", "101", "110", "100", "100", "100"],
  ["10001", "11011", "10101", "10101", "10001", "10001", "10001"]
];
const regular = [
  ["01110", "10001", "10001", "10001", "11111", "10001", "10001", "10001", "10001"],
  ["11110", "10001", "10001", "10001", "11110", "10000", "10000", "10000", "10000"],
  ["10001", "11011", "11011", "10101", "10101", "10001", "10001", "10001", "10001"]
];

function geometry(size) {
  const small = size <= 32;
  const glyphs = small ? compact : regular;
  const pitch = size === 16 ? 1 : size <= 48 ? 2 : 6;
  // Omit subpixel gaps on tiny icons; large squares have a one-pixel gap.
  const dot = size === 128 ? 5 : pitch;
  const columns = glyphs.reduce((sum, rows) => sum + rows[0].length, 0) + 2;
  const width = (columns - 1) * pitch + dot;
  const height = (glyphs[0].length - 1) * pitch + dot;
  const left = Math.floor((size - width) / 2);
  const top = Math.floor((size - height) / 2);
  const rectangles = [];
  let column = 0;
  for (const rows of glyphs) {
    rows.forEach((row, y) => [...row].forEach((value, x) => {
      if (value === "1") rectangles.push([left + (column + x) * pitch, top + y * pitch, dot, dot]);
    }));
    column += rows[0].length + 1;
  }
  return rectangles;
}

function pixels(size) {
  const rgb = Buffer.alloc(size * size * 3, 255);
  for (const [x, y, width, height] of geometry(size)) {
    for (let row = y; row < y + height; row += 1) {
      rgb.fill(0, (row * size + x) * 3, (row * size + x + width) * 3);
    }
  }
  return rgb;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, bytes) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  const crc = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  crc.writeUInt32BE(crc32(Buffer.concat([name, bytes])));
  return Buffer.concat([length, name, bytes, crc]);
}

function png(size, rgb) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2; // Opaque RGB: the white background is part of the icon.
  const rows = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y += 1) {
    rgb.copy(rows, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(rows, { level: 9 })), chunk("IEND", Buffer.alloc(0))
  ]);
}

function enlarged(size, scale) {
  const source = pixels(size);
  const outputSize = size * scale;
  const output = Buffer.alloc(outputSize * outputSize * 3);
  for (let y = 0; y < outputSize; y += 1) {
    for (let x = 0; x < outputSize; x += 1) {
      const input = (Math.floor(y / scale) * size + Math.floor(x / scale)) * 3;
      source.copy(output, (y * outputSize + x) * 3, input, input + 3);
    }
  }
  return png(outputSize, output);
}

function svg() {
  const rectangles = geometry(128).map(([x, y, width, height]) =>
    `    <rect x="${x}" y="${y}" width="${width}" height="${height}"/>`).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128" role="img" aria-labelledby="title" shape-rendering="crispEdges">\n  <title id="title">APM</title>\n  <rect width="128" height="128" fill="#fff"/>\n  <g fill="#000">\n${rectangles}\n  </g>\n</svg>\n`;
}

const args = process.argv.slice(2);
if (args.length > 1 || args.some((arg) => arg !== "--check" && !arg.startsWith("--preview="))) {
  throw new Error("Use no arguments, --check, or --preview=<directory>");
}
const preview = args.find((arg) => arg.startsWith("--preview="));
if (preview) {
  const directory = preview.slice("--preview=".length);
  if (!directory) throw new Error("A preview directory is required");
  mkdirSync(directory, { recursive: true });
  for (const [size, scale] of [[16, 12], [32, 6], [48, 4], [128, 4]]) {
    writeFileSync(path.join(directory, `apm-${size}-enlarged.png`), enlarged(size, scale));
  }
  console.log("Wrote nearest-neighbor previews (including 512px from the 128px icon)");
} else {
  const directory = fileURLToPath(new URL("../src/icons/", import.meta.url));
  const assets = new Map([["apm.svg", Buffer.from(svg())]]);
  for (const size of [16, 32, 48, 128]) assets.set(`apm-${size}.png`, png(size, pixels(size)));
  if (args.includes("--check")) {
    for (const [name, data] of assets) {
      if (!readFileSync(path.join(directory, name)).equals(data)) throw new Error(`Regeneration differs: ${name}`);
    }
    console.log("PASS: all four PNGs and the source SVG match deterministic regeneration");
  } else {
    mkdirSync(directory, { recursive: true });
    for (const [name, data] of assets) writeFileSync(path.join(directory, name), data);
    console.log("Generated APM icons: 16, 32, 48, 128px and source SVG");
  }
}
