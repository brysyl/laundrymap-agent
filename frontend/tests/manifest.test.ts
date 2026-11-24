import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const pub = join(__dirname, "..", "public");
const manifest = JSON.parse(readFileSync(join(pub, "manifest.webmanifest"), "utf8"));

function pngSize(file: string): { w: number; h: number } {
  const b = readFileSync(file);
  expect(b.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

describe("web app manifest", () => {
  it("has installability fields", () => {
    expect(manifest.name).toBe("Laundry-Map");
    expect(manifest.short_name).toBe("Laundry-Map");
    expect(manifest.start_url).toMatch(/^\//);
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.orientation).toBeTruthy();
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("start_url is inside scope", () => {
    expect(new URL(manifest.start_url, "https://x.test").pathname.startsWith(manifest.scope)).toBe(true);
  });

  it("declares 192 and 512 icons that exist with matching dimensions", () => {
    for (const size of [192, 512]) {
      const icon = manifest.icons.find((i: any) => i.sizes === `${size}x${size}` && i.purpose === "any");
      expect(icon, `any ${size}`).toBeTruthy();
      expect(icon.type).toBe("image/png");
      const file = join(pub, icon.src);
      expect(existsSync(file)).toBe(true);
      expect(pngSize(file)).toEqual({ w: size, h: size });
    }
  });

  it("declares maskable icons that exist with matching dimensions", () => {
    const masks = manifest.icons.filter((i: any) => i.purpose === "maskable");
    expect(masks.map((m: any) => m.sizes).sort()).toEqual(["192x192", "512x512"]);
    for (const m of masks) {
      const n = Number(m.sizes.split("x")[0]);
      expect(pngSize(join(pub, m.src))).toEqual({ w: n, h: n });
    }
  });

  it("maskable icons are fully opaque (full bleed)", async () => {
    const { inflateSync } = await import("node:zlib");
    const b = readFileSync(join(pub, "icons/icon-maskable-192.png"));
    // Single IDAT chunk: decode and check every alpha byte.
    let off = 8; const parts: Buffer[] = [];
    while (off < b.length) {
      const len = b.readUInt32BE(off); const type = b.subarray(off + 4, off + 8).toString();
      if (type === "IDAT") parts.push(b.subarray(off + 8, off + 8 + len));
      off += 12 + len;
    }
    const raw = inflateSync(Buffer.concat(parts));
    const stride = 192 * 4 + 1;
    for (let y = 0; y < 192; y++) for (let x = 0; x < 192; x++) expect(raw[y * stride + 1 + x * 4 + 3]).toBe(255);
  });

  it("apple touch icon exists at 180x180", () => {
    const f = join(pub, "icons/apple-touch-icon.png");
    expect(statSync(f).size).toBeGreaterThan(100);
    expect(pngSize(f)).toEqual({ w: 180, h: 180 });
  });

  it("layout links the manifest and apple touch icon", () => {
    const layout = readFileSync(join(__dirname, "..", "app", "layout.tsx"), "utf8");
    expect(layout).toContain('manifest: "/manifest.webmanifest"');
    expect(layout).toContain("/icons/apple-touch-icon.png");
    expect(layout).toContain("themeColor");
  });

  it("has an offline page", () => {
    expect(existsSync(join(__dirname, "..", "app", "offline", "page.tsx"))).toBe(true);
  });
});
