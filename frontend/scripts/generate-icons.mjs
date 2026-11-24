// Generates PWA icons as PNG with a dependency-free encoder (zlib + CRC32).
// Usage: npm run icons --workspace=frontend
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
const BLUE = [14, 116, 144];
const LIGHT = [207, 250, 254];
const WHITE = [255, 255, 255];
const WATER = [34, 211, 238];

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Color at normalized coordinates (0..1), or null for transparent. */
function sample(x, y, { maskable }) {
  if (!maskable) {
    // Rounded square background with transparent corners.
    const r = 0.22;
    const dx = Math.max(Math.abs(x - 0.5) - (0.5 - r), 0);
    const dy = Math.max(Math.abs(y - 0.5) - (0.5 - r), 0);
    if (dx * dx + dy * dy > r * r) return null;
  }
  // Content is scaled into the central safe zone (maskable icons keep 80% safe area).
  const scale = maskable ? 0.62 : 0.78;
  const u = (x - 0.5) / scale;
  const v = (y - 0.5) / scale;
  const d = Math.hypot(u, v);
  if (d <= 0.5) {
    if (d > 0.4) return WHITE; // washer door ring
    // Water in the lower half with a wavy surface.
    const surface = 0.05 + 0.04 * Math.sin(u * 14);
    return v > surface ? WATER : LIGHT;
  }
  // Washer body corner dots (control knobs) above the drum.
  return BLUE;
}

function render(size, opts) {
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 3;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size, opts);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 1; }
        }
      }
      const o = (py * size + px) * 4;
      if (a > 0) {
        rgba[o] = Math.round(r / a);
        rgba[o + 1] = Math.round(g / a);
        rgba[o + 2] = Math.round(b / a);
      }
      rgba[o + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  return encodePng(size, rgba);
}

const targets = [
  ["icon-192.png", 192, false],
  ["icon-512.png", 512, false],
  ["icon-maskable-192.png", 192, true],
  ["icon-maskable-512.png", 512, true],
  ["apple-touch-icon.png", 180, true],
];

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(OUT, { recursive: true });
  for (const [name, size, maskable] of targets) {
    writeFileSync(join(OUT, name), render(size, { maskable }));
    console.log(`wrote ${name} (${size}x${size})`);
  }
}
