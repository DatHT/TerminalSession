// Generates assets/command-icon.png — a 512×512 icon: a bold amber ">_" prompt
// on a charcoal rounded square. No dependencies (hand-rolled PNG encoder).
// Rendered at 2× and box-downsampled for anti-aliased edges.
//
//   node assets/make-icon.mjs

import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "command-icon.png");

const SIZE = 512;
const SS = 2; // supersample factor
const S = SIZE * SS;

// palette
const CHARCOAL = [0x12, 0x15, 0x1c];
const AMBER = [0xe9, 0xa9, 0x4c];

const buf = new Uint8Array(S * S * 4); // RGBA, transparent by default

function setPx(x, y, [r, g, b], a = 255) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
}

// Rounded-square ground.
function roundedSquare(margin, radius, color) {
  const lo = margin, hi = S - margin, r = radius;
  for (let y = lo; y < hi; y++) {
    for (let x = lo; x < hi; x++) {
      const dx = x < lo + r ? lo + r - x : x > hi - r ? x - (hi - r) : 0;
      const dy = y < lo + r ? lo + r - y : y > hi - r ? y - (hi - r) : 0;
      if (dx * dx + dy * dy <= r * r) setPx(x, y, color);
    }
  }
}

// Thick line segment (rounded caps).
function thickLine(x1, y1, x2, y2, thick, color) {
  const half = thick / 2;
  const minX = Math.floor(Math.min(x1, x2) - half), maxX = Math.ceil(Math.max(x1, x2) + half);
  const minY = Math.floor(Math.min(y1, y2) - half), maxY = Math.ceil(Math.max(y1, y2) + half);
  const vx = x2 - x1, vy = y2 - y1, len2 = vx * vx + vy * vy;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      let t = len2 ? ((x - x1) * vx + (y - y1) * vy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const px = x1 + t * vx, py = y1 + t * vy;
      const dx = x - px, dy = y - py;
      if (dx * dx + dy * dy <= half * half) setPx(x, y, color);
    }
  }
}

function rect(x0, y0, x1, y1, radius, color) {
  thickLine(x0 + radius, (y0 + y1) / 2, x1 - radius, (y0 + y1) / 2, y1 - y0, color);
}

// --- compose (coords in supersampled space) ---
roundedSquare(0 * SS, 112 * SS, CHARCOAL);
// ">" chevron
const T = 46 * SS;
thickLine(150 * SS, 150 * SS, 288 * SS, 256 * SS, T, AMBER);
thickLine(288 * SS, 256 * SS, 150 * SS, 362 * SS, T, AMBER);
// "_" cursor block
rect(300 * SS, 330 * SS, 420 * SS, 372 * SS, 20 * SS, AMBER);

// --- downsample 2×2 -> 512 ---
const out = new Uint8Array(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = ((y * SS + sy) * S + (x * SS + sx)) * 4;
        r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3];
      }
    }
    const n = SS * SS, o = (y * SIZE + x) * 4;
    out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
  }
}

fs.writeFileSync(OUT, encodePng(SIZE, SIZE, out));
console.log("wrote", OUT);

// ---- minimal PNG encoder ----
function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.subarray(y * w * 4, (y + 1) * w * 4).forEach((v, i) => {
      raw[y * (w * 4 + 1) + 1 + i] = v;
    });
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
function chunk(type, data) {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 0);
  return Buffer.concat([len, t, data, crc]);
}
var CRC_TABLE;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}
