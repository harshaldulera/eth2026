import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ATTACK_CLASSES, CLASS_META, moveToStamp } from "@/lib/scene/classes";
import { getManifest, getSprite, guardKind, guardSprite, spriteDataUri, spriteNames, spriteSvg, validateManifest } from "./manifest";
import { GUARD_KINDS, GUARD_POSES, hasGenerator, resolveTokens, TOK, type GuardSpritePose } from "./sprite";
import { scaleForViewport } from "./scale";

const PUBLIC = path.join(__dirname, "..", "..", "public");
const fileOf = (src: string) => path.join(PUBLIC, src.replace(/^\//, ""));

/** Width/height from a PNG's IHDR chunk. */
function pngSize(file: string): [number, number] {
  const b = readFileSync(file);
  expect(b.subarray(1, 4).toString("ascii")).toBe("PNG");
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

describe("sprite manifest", () => {
  const m = getManifest();

  it("is structurally valid", () => {
    expect(validateManifest(m)).toEqual([]);
    expect(validateManifest({ sprites: { x: { w: 16, h: 16, frames: 2, src: ["/a.png"] } }, tiles: {} }).map((p) => p.problem)).toContain("src[] length must equal frames");
  });

  it.each(spriteNames())("%s resolves to an existing file or a generator", (name) => {
    const e = getSprite(name)!;
    if (e.src) {
      for (const src of Array.isArray(e.src) ? e.src : [e.src]) {
        expect(existsSync(fileOf(src)), src).toBe(true);
        const [w, h] = pngSize(fileOf(src));
        expect(w).toBe(Array.isArray(e.src) ? e.w : e.w * e.frames);
        expect(h).toBe(e.h);
      }
    }
    // every sprite — PNG ones included — has a generator to fall back on
    expect(e.svg, `${name} needs a generator`).toBeTruthy();
    expect(hasGenerator(e.svg!), `generator ${e.svg}`).toBe(true);
    const svg = spriteSvg(name);
    expect(svg).toMatch(new RegExp(`^<svg [^>]*width="${e.w * e.frames}" height="${e.h}"`));
    expect(svg).toContain("<path ");
    expect(svg).not.toContain("NaN");
    expect(spriteDataUri(name)).toMatch(/^data:image\/svg\+xml/);
  });

  it("embedded tiles match the CC0 PNGs they came from", () => {
    for (const [id, t] of Object.entries(m.tiles)) {
      expect(existsSync(fileOf(t.src)), id).toBe(true);
      expect(pngSize(fileOf(t.src))).toEqual([t.w, t.h]);
      expect(t.rows.join("")).toMatch(/^[a-z.]+$/);
    }
  });

  it("has every sprite the scene and screens ask for", () => {
    for (const c of ATTACK_CLASSES) expect(getSprite(CLASS_META[c].icon), c).toBeDefined();
    for (const mv of ["hold", "expose", "banish", "open"] as const) expect(getSprite(moveToStamp(mv).icon)).toBeDefined();
    for (const k of GUARD_KINDS)
      for (const p of Object.keys(GUARD_POSES) as GuardSpritePose[]) {
        const e = getSprite(`guard.${k}.${p}`);
        expect(e, `guard.${k}.${p}`).toBeDefined();
        expect(e!.frames).toBe(GUARD_POSES[p].frames);
        expect(e!.w).toBe(k === "paranoid" ? 24 : 16);
      }
    for (const n of ["door.closed", "door.shaking", "door.open", "shutter", "packet", "coin", "clock", "inbox", "mirror", "padlock", "credential", "radio", "pager", "fx.static", "operator.idle", "operator.think", "rank.0", "rank.1", "rank.2", "rank.3"])
      expect(getSprite(n), n).toBeDefined();
    expect(getSprite("door.open")!.frames).toBe(4);
  });

  it("unknown names render the missing box instead of throwing", () => {
    expect(getSprite("nope")).toBeUndefined();
    expect(spriteSvg("nope")).toContain("<svg");
  });

  it("skin tokens resolve to live values, else their CRT fallbacks", () => {
    const svg = spriteSvg("coin");
    expect(svg).toContain("var(--color-money,");
    expect(resolveTokens(svg)).not.toContain("var(");
    expect(resolveTokens(svg)).toContain("#ffd24a");
    expect(resolveTokens(svg, { "--color-money": "#ffe14d" })).toContain("#ffe14d");
    expect(resolveTokens(svg, { "--color-money": '"><script>' })).toContain("#ffd24a");
    expect(Object.values(TOK).every((v) => /^var\(--color-[a-z-]+,#[0-9a-f]{6}\)$/.test(v))).toBe(true);
  });
});

describe("guards", () => {
  it("picks a portrait per personality; SDK guards are the support bot", () => {
    expect(guardKind({ personality: "bumbling" })).toBe("bumbling");
    expect(guardKind({ personality: "paranoid", transport: "hosted" })).toBe("paranoid");
    expect(guardKind({ personality: "stern", transport: "sdk", guardianName: "Penny the Support Bot" })).toBe("support-bot");
    expect(guardKind({ personality: "weird" })).toBe("stern");
  });

  it("maps scene poses to sprites", () => {
    expect(guardSprite("bumbling", "thinking")).toEqual({ name: "guard.bumbling.think", animate: { fps: 4, loop: true } });
    expect(guardSprite("paranoid", "breach")).toEqual({ name: "guard.paranoid.breach", animate: { fps: 5, loop: false } });
    expect(guardSprite("stern", "alert").name).toBe("guard.stern.idle");
  });
});

describe("pixel scale", () => {
  it("2 phone / 3 desktop / 4 wall", () => {
    expect(scaleForViewport(390, 844)).toBe(2);
    expect(scaleForViewport(1440, 900)).toBe(3);
    expect(scaleForViewport(1920, 1080)).toBe(4);
    expect(scaleForViewport(1920, 900)).toBe(3);
  });
});
