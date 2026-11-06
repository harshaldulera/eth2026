/**
 * Code-drawn pixel sprites (plan §2.4). Every sprite is a strip of frames on a 16-px grid, rendered
 * to an SVG string of crisp 1×1 runs. Colours are either fixed art colours (the Tiny Dungeon
 * palette, so code art sits next to the CC0 tiles) or skin tokens written as
 * `var(--color-x,#fallback)`: `resolveTokens` swaps those for the live skin values before the SVG
 * becomes a data URI (an SVG image cannot see the page's CSS variables).
 *
 * Guard portraits are composed: a Tiny Dungeon character tile (pixels embedded in
 * public/pixel/manifest.json) plus code-drawn headgear, props and pose overlays per frame.
 *
 * Pure and framework-free (no DOM): tests render every sprite in Node.
 */

// ─── colours ───────────────────────────────────────────────────────────────────────────

/** Skin tokens with the CRT skin's values as fallbacks. */
export const TOK = {
  ink: "var(--color-ink,#c9f7c9)",
  dim: "var(--color-ink-dim,#6f9c75)",
  accent: "var(--color-accent,#7dff9a)",
  money: "var(--color-money,#ffd24a)",
  threat: "var(--color-threat,#ff5a3c)",
  safe: "var(--color-safe,#5ee0a0)",
  warn: "var(--color-warn,#ffb347)",
  line: "var(--color-line,#1e3a24)",
  panel: "var(--color-panel,#0a120c)",
  raised: "var(--color-raised,#101b12)",
  bg: "var(--color-bg,#040705)",
} as const;

/** Fixed art colours (Kenney Tiny Dungeon palette + a few additions). */
export const ART = {
  outline: "#3f2631",
  navy: "#262b44",
  steel1: "#c0cbdc",
  steel2: "#8b9bb4",
  steel3: "#52607c",
  steel4: "#3a4466",
  brown: "#bd6c4a",
  brownDark: "#763b36",
  skin: "#f7c282",
  skinMid: "#e19a65",
  green: "#25956a",
  greenLight: "#5ac07a",
  teal: "#43e1b3",
  red: "#e84537",
  redBright: "#ff8a6a",
  yellow: "#fee761",
  gold: "#feae34",
  goldDark: "#c28a1c",
  goldLight: "#fff3a8",
  white: "#ffffff",
  parchment: "#e8d8b0",
  mustard: "#c98f2a",
  mustardLight: "#e8b84a",
  marsh: "#2f5a3b",
  marshLight: "#4a7f4f",
  ember: "#f77622",
  glass: "#bfefff",
  sweat: "#8fd3ff",
} as const;

export type Color = string;
type Pal = Record<string, Color | null>;

// ─── raster ────────────────────────────────────────────────────────────────────────────

type Px = { c: Color; a: number } | null;

const HEX = /^#[0-9a-f]{6}$/i;

function mixHex(base: string, over: string, a: number): string {
  const p = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  let out = "#";
  for (let i = 0; i < 3; i++) out += Math.round(p(base, i) * (1 - a) + p(over, i) * a).toString(16).padStart(2, "0");
  return out;
}

export class Raster {
  readonly px: Px[];
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.px = new Array<Px>(w * h).fill(null);
  }
  get(x: number, y: number): Px {
    return x < 0 || y < 0 || x >= this.w || y >= this.h ? null : this.px[y * this.w + x];
  }
  /** Paint a pixel. A translucent hex colour over an opaque hex pixel is blended (glass, glows). */
  set(x: number, y: number, c: Color | null, a = 1): this {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return this;
    const i = y * this.w + x;
    const under = this.px[i];
    if (c !== null && a < 1 && under && HEX.test(c) && HEX.test(under.c)) {
      this.px[i] = { c: mixHex(under.c, c, a), a: under.a };
      return this;
    }
    this.px[i] = c === null ? null : { c, a };
    return this;
  }
  rect(x: number, y: number, w: number, h: number, c: Color | null, a = 1): this {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c, a);
    return this;
  }
  /** Outline of a rectangle. */
  box(x: number, y: number, w: number, h: number, c: Color, a = 1): this {
    for (let i = 0; i < w; i++) this.set(x + i, y, c, a).set(x + i, y + h - 1, c, a);
    for (let j = 0; j < h; j++) this.set(x, y + j, c, a).set(x + w - 1, y + j, c, a);
    return this;
  }
  /** Filled ellipse: every pixel whose centre lies inside. */
  ellipse(cx: number, cy: number, rx: number, ry: number, c: Color | null, a = 1): this {
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++) {
        const dx = (x + 0.5 - cx) / rx;
        const dy = (y + 0.5 - cy) / ry;
        if (dx * dx + dy * dy <= 1) this.set(x, y, c, a);
      }
    return this;
  }
  line(x0: number, y0: number, x1: number, y1: number, c: Color, a = 1): this {
    x0 = Math.round(x0);
    y0 = Math.round(y0);
    x1 = Math.round(x1);
    y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.set(x0, y0, c, a);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
    return this;
  }
  /** ASCII art: one char per pixel; '.' and ' ' are transparent; chars missing from `pal` are skipped. */
  draw(rows: readonly string[], pal: Pal, dx = 0, dy = 0, a = 1): this {
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const ch = row[x];
        if (ch === "." || ch === " ") continue;
        if (!(ch in pal)) continue;
        this.set(dx + x, dy + y, pal[ch], a);
      }
    });
    return this;
  }
  /** Copy another raster on top (transparent pixels skipped). */
  paste(src: Raster, dx = 0, dy = 0, a = 1): this {
    for (let y = 0; y < src.h; y++)
      for (let x = 0; x < src.w; x++) {
        const p = src.get(x, y);
        if (p) this.set(dx + x, dy + y, p.c, p.a * a);
      }
    return this;
  }
  /** Replace colours (exact match). */
  recolor(map: Readonly<Record<string, Color>>): this {
    for (let i = 0; i < this.px.length; i++) {
      const p = this.px[i];
      if (p && map[p.c.toLowerCase()]) this.px[i] = { c: map[p.c.toLowerCase()], a: p.a };
    }
    return this;
  }
  /** Pixels of `colour` around every opaque pixel (1-px outline). */
  outline(c: Color): this {
    const add: [number, number][] = [];
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++) {
        if (this.get(x, y)) continue;
        if (this.get(x - 1, y) || this.get(x + 1, y) || this.get(x, y - 1) || this.get(x, y + 1)) add.push([x, y]);
      }
    for (const [x, y] of add) this.set(x, y, c);
    return this;
  }
  /** SVG paths, one per colour/alpha, offset by `ox`. Horizontal runs merged. */
  toSvg(ox = 0): string {
    const groups = new Map<string, string[]>();
    for (let y = 0; y < this.h; y++) {
      let x = 0;
      while (x < this.w) {
        const p = this.get(x, y);
        if (!p) {
          x++;
          continue;
        }
        let run = 1;
        while (x + run < this.w) {
          const q = this.get(x + run, y);
          if (!q || q.c !== p.c || q.a !== p.a) break;
          run++;
        }
        const key = `${p.c}|${p.a}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(`M${x + ox} ${y}h${run}v1h-${run}z`);
        x += run;
      }
    }
    let out = "";
    for (const [key, d] of groups) {
      const [c, a] = key.split("|");
      out += `<path fill="${c}"${a !== "1" ? ` fill-opacity="${a}"` : ""} d="${d.join("")}"/>`;
    }
    return out;
  }
  clone(): Raster {
    const r = new Raster(this.w, this.h);
    for (let i = 0; i < this.px.length; i++) r.px[i] = this.px[i];
    return r;
  }
}

/** Frames → one horizontal strip SVG (frame i at x = i × w). */
export function stripSvg(frames: readonly Raster[], w: number, h: number): string {
  const n = Math.max(1, frames.length);
  const body = frames.map((f, i) => f.toSvg(i * w)).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w * n}" height="${h}" viewBox="0 0 ${w * n} ${h}" shape-rendering="crispEdges">${body}</svg>`;
}

const TOKEN_RE = /var\((--[a-z0-9-]+),\s*(#[0-9a-fA-F]{3,8})\)/g;

/** Swap `var(--x,#fallback)` for the live token value (or the fallback). */
export function resolveTokens(svg: string, tokens?: Readonly<Record<string, string>> | null): string {
  return svg.replace(TOKEN_RE, (_, name: string, fallback: string) => {
    const v = tokens?.[name]?.trim();
    return v && !/[<>"]/.test(v) ? v : fallback;
  });
}

/** Token names the generators use (for the client to read from :root). */
export const TOKEN_NAMES: readonly string[] = Object.values(TOK).map((v) => v.slice(4, v.indexOf(",")));

export function svgDataUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// ─── tiles ─────────────────────────────────────────────────────────────────────────────

export type TileData = { src: string; w: number; h: number; palette: string[]; rows: string[]; name?: string };

const IDX = "abcdefghijklmnopqrstuvwxyz";

/** Raster from embedded tile pixels (palette-indexed rows from the manifest). */
export function tileRaster(tile: TileData): Raster {
  const r = new Raster(tile.w, tile.h);
  tile.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const i = IDX.indexOf(row[x]);
      if (i >= 0 && tile.palette[i]) r.set(x, y, tile.palette[i]);
    }
  });
  return r;
}

// ─── generator registry ────────────────────────────────────────────────────────────────

export type GenArgs = Record<string, string | number | boolean | undefined>;
export type GenCtx = { w: number; h: number; frames: number; tiles: Readonly<Record<string, TileData>>; base?: string };
export type Generator = (args: GenArgs, ctx: GenCtx) => Raster[];

const blank = (ctx: GenCtx) => new Raster(ctx.w, ctx.h);
const frames = (ctx: GenCtx, fn: (i: number, r: Raster) => void): Raster[] =>
  Array.from({ length: ctx.frames }, (_, i) => {
    const r = blank(ctx);
    fn(i, r);
    return r;
  });

/** Deterministic PRNG (static, noise). */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const O = ART.outline;

// ── vault door ───────────────────────────────────────────────────────────────────────

function vaultFrame(r: Raster) {
  r.rect(0, 0, 16, 16, ART.navy);
  r.box(0, 0, 16, 16, O);
  r.rect(1, 1, 14, 1, ART.steel4);
}

function vaultInterior(r: Raster) {
  r.rect(2, 2, 12, 12, "#141729");
  // gold piled inside, glowing
  r.draw(
    [
      "..........",
      "....yy....",
      "...yMMy...",
      "..yMMMMy..",
      ".yMMMMMMy.",
      "yMMGMMGMMy",
      "MMGMMMMGMM",
      "GGGGGGGGGG",
    ],
    { y: ART.goldLight, M: TOK.money, G: ART.goldDark },
    3,
    5,
  );
  r.set(4, 3, ART.goldLight, 0.6).set(11, 4, ART.goldLight, 0.6).set(8, 2, ART.white, 0.5);
}

function vaultDoor(r: Raster, cx: number, rx: number, shade = 0) {
  r.ellipse(cx, 8, rx, 6.9, O);
  if (rx > 1.6) r.ellipse(cx, 8, rx - 1, 5.9, shade ? ART.steel3 : ART.steel2);
  if (rx > 2.6) r.ellipse(cx, 8, rx - 2, 4.9, shade ? ART.steel2 : ART.steel1);
  if (rx >= 5) {
    // wheel: hub + four spokes with knobs
    r.ellipse(cx, 8, 1.6, 1.6, ART.steel3);
    const c = Math.floor(cx);
    r.rect(c - 1, 4, 2, 3, ART.steel3).rect(c - 1, 9, 2, 3, ART.steel3);
    r.rect(c - 4, 7, 3, 2, ART.steel3).rect(c + 1, 7, 3, 2, ART.steel3);
    r.set(c - 1, 3, ART.gold).set(c, 3, ART.gold).set(c - 1, 12, ART.gold).set(c, 12, ART.gold);
    r.set(c - 5, 7, ART.gold).set(c - 5, 8, ART.gold).set(c + 4, 7, ART.gold).set(c + 4, 8, ART.gold);
    r.set(c - 1, 7, ART.white).set(c, 7, ART.steel1);
    // bolts on the rim
    for (const [bx, by] of [
      [-5, 2],
      [4, 2],
      [-5, 13],
      [4, 13],
    ])
      r.set(c + bx, by, ART.steel1);
    // highlight arc
    r.set(c - 3, 3, ART.white, 0.7).set(c - 4, 4, ART.white, 0.7);
  } else if (rx > 2) {
    r.rect(Math.floor(cx) - 1, 7, 1, 2, ART.gold);
  }
}

const doorClosed: Generator = (_a, ctx) =>
  frames(ctx, (_i, r) => {
    vaultFrame(r);
    vaultDoor(r, 8, 7);
  });

const doorShaking: Generator = (_a, ctx) =>
  frames(ctx, (i, r) => {
    vaultFrame(r);
    vaultDoor(r, i % 2 ? 9 : 7, 7);
    // dust and a warning glint on the frame
    const side = i % 2 ? 1 : 14;
    r.set(side, 13, ART.steel2, 0.8).set(side, 11, ART.steel2, 0.5);
    r.set(i % 2 ? 2 : 13, 1, TOK.threat);
  });

/** 0 crack of light · 1 swinging · 2 nearly open · 3 open, gold pouring light. */
const doorOpen: Generator = (_a, ctx) =>
  frames(ctx, (i, r) => {
    vaultFrame(r);
    vaultInterior(r);
    if (i === 0) {
      vaultDoor(r, 7.6, 7);
      r.rect(14, 3, 1, 10, ART.goldLight);
    } else if (i === 1) {
      vaultDoor(r, 5.5, 4.6, 1);
    } else if (i === 2) {
      vaultDoor(r, 3.4, 2.6, 1);
    } else {
      r.rect(1, 2, 2, 12, ART.steel3).rect(1, 2, 1, 12, O);
      // light spilling out
      r.set(13, 2, ART.white, 0.7).set(14, 6, ART.goldLight, 0.8).set(12, 1, ART.goldLight, 0.6);
    }
  });

// ── shutter (lockdown) ───────────────────────────────────────────────────────────────

const shutter: Generator = (_a, ctx) =>
  frames(ctx, (i, r) => {
    const n = ctx.frames;
    const rows = Math.round(((i + 1) / n) * ctx.h);
    for (let y = 0; y < rows; y++) r.rect(0, y, ctx.w, 1, y % 3 === 2 ? O : y % 3 === 0 ? ART.steel2 : ART.steel3);
    if (i === n - 1) {
      r.rect(0, 7, ctx.w, 2, TOK.threat);
      for (let x = 1; x < ctx.w; x += 4) r.set(x, 7, ART.navy).set(x + 1, 8, ART.navy);
    }
    if (rows < ctx.h) r.rect(0, rows - 1, ctx.w, 1, ART.steel4);
    r.rect(0, Math.max(0, rows - 1), 1, 1, O).rect(ctx.w - 1, Math.max(0, rows - 1), 1, 1, O);
  });

// ── small things ─────────────────────────────────────────────────────────────────────

/** 8×8 data packet, 2 frames (bits blink). */
const packet: Generator = (_a, ctx) =>
  frames(ctx, (i, r) => {
    r.draw(["oooooooo", "oAAAAAAo", "oA....Ao", "oA....Ao", "oA....Ao", "oA....Ao", "oAAAAAAo", "oooooooo"], { o: TOK.bg, A: TOK.accent });
    const bits = i ? ["I.I.", ".I.I", "I..I", ".II."] : [".I.I", "I.I.", ".II.", "I..I"];
    r.draw(bits, { I: TOK.ink }, 2, 2);
  });

/** 8×8 coin, 4 frames spinning. */
const coin: Generator = (_a, ctx) => {
  const art = [
    ["..oooo..", ".oMMMMo.", "oMyMMMGo", "oMyMMMGo", "oMyMMMGo", "oMMMMMGo", ".oGGGGo.", "..oooo.."],
    ["...oo...", "..oMMo..", ".oMyMGo.", ".oMyMGo.", ".oMyMGo.", ".oMMMGo.", "..oGGo..", "...oo..."],
    ["...oo...", "...yo...", "...Mo...", "...Mo...", "...Mo...", "...Mo...", "...Go...", "...oo..."],
    ["...oo...", "..oMMo..", ".oGMyMo.", ".oGMyMo.", ".oGMyMo.", ".oGMMMo.", "..oGGo..", "...oo..."],
  ];
  return frames(ctx, (i, r) => r.draw(art[i % 4], { o: ART.goldDark, M: TOK.money, y: ART.goldLight, G: ART.gold }));
};

/** Wall clock, 4 frames: the minute hand sweeps 12 → 3 → 6 → 9. */
const clock: Generator = (_a, ctx) =>
  frames(ctx, (i, r) => {
    r.ellipse(8, 8, 7.6, 7.6, TOK.bg);
    r.ellipse(8, 8, 6.8, 6.8, TOK.dim);
    r.ellipse(8, 8, 5.8, 5.8, TOK.ink);
    for (const [x, y] of [
      [7, 3],
      [8, 3],
      [12, 7],
      [12, 8],
      [7, 12],
      [8, 12],
      [3, 7],
      [3, 8],
    ])
      r.set(x, y, TOK.dim);
    // hour hand (short, fixed toward 10)
    r.line(7, 7, 5, 6, TOK.bg);
    const hands = [
      [7, 7, 7, 3],
      [8, 7, 12, 7],
      [8, 8, 8, 12],
      [7, 8, 3, 8],
    ][i % 4];
    r.line(hands[0], hands[1], hands[2], hands[3], TOK.threat);
    r.rect(7, 7, 2, 2, TOK.bg);
    r.set(8, 7, TOK.threat);
  });

/** Inbox tray; frame 1 holds a spoofed packet with a "!" tag. */
const inbox: Generator = (_a, ctx) =>
  frames(ctx, (i, r) => {
    if (i) {
      r.draw(["oooooooo", "oAAAAAAo", "oA.II.Ao", "oA.II.Ao", "oAAAAAAo"], { o: TOK.bg, A: TOK.warn, I: TOK.ink }, 4, 4);
      r.draw(["HH", "HH", "..", "HH"], { H: TOK.threat }, 13, 1);
    }
    r.draw(
      [
        ".II..........II.",
        ".IDI........IDI.",
        ".IDDI......IDDI.",
        ".IDDDIIIIIIDDDI.",
        ".IDDDDDDDDDDDDI.",
        ".IIIIIIIIIIIIII.",
        "..oooooooooooo..",
      ],
      { I: TOK.ink, D: TOK.dim, o: TOK.bg },
      0,
      8,
    );
  });

/** Padlock (16×16). */
function padlock(r: Raster, dx = 0, dy = 0, body: Color = ART.gold, a = 1) {
  r.draw(
    [
      ".....oooooo.....",
      "....o111111o....",
      "...o11oooo11o...",
      "...o1o....o1o...",
      "...o1o....o1o...",
      "..oooooooooooo..",
      "..oyyyyyyyyyyo..",
      "..oyMMMMMMMMGo..",
      "..oyMMMooMMMGo..",
      "..oyMMMooMMMGo..",
      "..oyMMMMoMMMGo..",
      "..oyMMMMMMMMGo..",
      "..oGGGGGGGGGGo..",
      "..oooooooooooo..",
    ],
    { o: O, "1": ART.steel1, y: ART.goldLight, M: body, G: ART.goldDark },
    dx,
    dy + 1,
    a,
  );
}

const padlockGen: Generator = (_a, ctx) => frames(ctx, (_i, r) => padlock(r));

/** Mirror on a stand; frame 1 shows the padlock in the reflection. */
const mirror: Generator = (_a, ctx) =>
  frames(ctx, (i, r) => {
    r.ellipse(8, 7, 6.2, 7, ART.goldDark);
    r.ellipse(8, 7, 5.2, 6, ART.gold);
    r.ellipse(8, 7, 4.2, 5, "#9fd8e8");
    r.ellipse(8, 7, 3.2, 4, "#c8f0f8");
    if (i) {
      r.draw(["..oo..", ".o..o.", "oooooo", "oMMMMo", "oMooMo", "oMMMMo", "oooooo"], { o: O, M: TOK.money }, 5, 4, 0.85);
    } else {
      r.set(6, 3, ART.white).set(5, 4, ART.white).set(5, 5, ART.white, 0.7);
    }
    r.rect(7, 14, 2, 1, ART.goldDark).rect(5, 15, 6, 1, ART.goldDark);
  });

/** Forged credential card; frame 1 blinks a red FORGED? stamp across it. */
const credential: Generator = (_a, ctx) =>
  frames(ctx, (i, r) => {
    r.rect(0, 3, 16, 11, TOK.bg);
    r.rect(1, 4, 14, 9, TOK.ink);
    r.rect(1, 4, 14, 2, TOK.accent);
    r.set(13, 4, TOK.money).set(12, 5, TOK.money).set(13, 5, TOK.money);
    // photo
    r.rect(2, 7, 4, 5, TOK.dim);
    r.rect(3, 8, 2, 2, ART.skin).rect(3, 10, 2, 2, ART.steel3);
    // lines
    r.rect(7, 7, 6, 1, TOK.dim).rect(7, 9, 5, 1, TOK.dim).rect(7, 11, 6, 1, TOK.dim);
    if (i) {
      r.box(1, 6, 14, 5, TOK.threat);
      r.line(3, 10, 12, 7, TOK.threat);
      r.draw(["HH.", "..H", ".H.", "...", ".H."], { H: TOK.threat }, 12, 0);
    }
  });

/** Handheld radio; frames add signal bars 1 → 3. */
const radio: Generator = (_a, ctx) =>
  frames(ctx, (i, r) => {
    r.rect(3, 0, 1, 5, TOK.dim);
    r.rect(1, 4, 8, 12, TOK.bg);
    r.rect(2, 5, 6, 10, TOK.dim);
    r.rect(3, 6, 4, 3, TOK.accent);
    r.set(3, 6, TOK.ink);
    for (let y = 10; y < 14; y += 2) r.rect(3, y, 4, 1, TOK.bg);
    r.set(7, 5, TOK.threat);
    const bars = (i % 3) + 1;
    for (let b = 0; b < bars; b++) r.rect(10 + b * 2, 9 - b * 3, 1, 3 + b * 3, TOK.accent);
  });

/** Pager; frame 1 lights the alert LED and the LCD text. */
const pager: Generator = (_a, ctx) =>
  frames(ctx, (i, r) => {
    r.rect(0, 3, 16, 11, TOK.bg);
    r.rect(1, 4, 14, 9, TOK.dim);
    r.rect(2, 5, 9, 5, TOK.panel);
    r.rect(2, 5, 9, 5, TOK.accent, 0.25);
    if (i) r.rect(3, 6, 6, 1, TOK.accent).rect(3, 8, 4, 1, TOK.accent);
    r.rect(12, 5, 2, 2, i ? TOK.threat : TOK.bg);
    r.rect(12, 9, 2, 1, TOK.bg).rect(3, 11, 3, 1, TOK.bg).rect(7, 11, 3, 1, TOK.bg);
  });

/** Static noise for the obfuscation effect (deterministic per frame). */
const staticFx: Generator = (args, ctx) =>
  frames(ctx, (i, r) => {
    const rand = rng(97 + i * 7919 + Number(args.seed ?? 0));
    for (let y = 0; y < ctx.h; y++)
      for (let x = 0; x < ctx.w; x++) {
        const v = rand();
        r.set(x, y, v > 0.82 ? TOK.ink : v > 0.5 ? TOK.dim : v > 0.2 ? TOK.line : TOK.bg);
      }
  });

// ── class icons ──────────────────────────────────────────────────────────────────────

const ICON_PAL: Pal = { I: TOK.ink, D: TOK.dim, A: TOK.accent, U: TOK.warn, H: TOK.threat, M: TOK.money, F: TOK.safe, o: TOK.bg, y: ART.goldLight, G: ART.goldDark };

function silhouette(r: Raster, x: number, y: number, c: Color) {
  r.draw(["..XXXX..", ".XXXXXX.", ".XXXXXX.", "..XXXX..", "........", "..XXXX..", ".XXXXXX.", "XXXXXXXX", "XXXXXXXX", "XXXXXXXX", "XXXXXXXX"], { X: c }, x, y);
}

const ICONS: Record<string, (r: Raster, i: number) => void> = {
  authority: (r) =>
    r.draw(
      [
        "................",
        "...MMMMMMMMMM...",
        "..MyyyyyyyyyyM..",
        "..MyMMMMMMMMGM..",
        "..MyMMMyyMMMGM..",
        "..MyMMyyyyMMGM..",
        "..MyMyyyyyyMGM..",
        "..MyMMyyyyMMGM..",
        "..MyMMyMMyMMGM..",
        "..MyMMMMMMMMGM..",
        "...MyMMMMMMGM...",
        "....MyMMMMGM....",
        ".....MyMMGM.....",
        "......MGGM......",
        ".......MM.......",
        "................",
      ],
      ICON_PAL,
    ),
  override: (r) => {
    const ghost = new Raster(16, 16);
    silhouette(ghost, 7, 1, TOK.warn);
    const hollow = new Raster(16, 16).paste(ghost);
    // keep only the edge of the ghost
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++)
        if (ghost.get(x, y) && ghost.get(x - 1, y) && ghost.get(x + 1, y) && ghost.get(x, y - 1) && ghost.get(x, y + 1)) hollow.set(x, y, null);
    r.paste(hollow);
    silhouette(r, 1, 4, TOK.ink);
  },
  injection: (r) =>
    r.draw(
      [
        ".......UU.......",
        ".......UU.......",
        ".......UU.......",
        ".....UUUUUU.....",
        "......UUUU......",
        ".......UU.......",
        "................",
        ".II..........II.",
        ".IDI........IDI.",
        ".IDDI......IDDI.",
        ".IDDDIIIIIIDDDI.",
        ".IDDDDDDDDDDDDI.",
        ".IIIIIIIIIIIIII.",
        "................",
      ],
      ICON_PAL,
      0,
      1,
    ),
  obfuscation: (r, i) => {
    r.rect(0, 1, 16, 13, TOK.dim);
    r.rect(1, 2, 14, 11, TOK.bg);
    const rand = rng(31 + i * 101);
    for (let y = 3; y < 12; y++) for (let x = 2; x < 14; x++) if (rand() > 0.45) r.set(x, y, rand() > 0.5 ? TOK.ink : TOK.dim);
    r.rect(6, 14, 4, 1, TOK.dim).rect(4, 15, 8, 1, TOK.dim);
  },
  pressure: (r) => {
    r.ellipse(8, 8, 7.6, 7.6, TOK.ink);
    r.ellipse(8, 8, 6.4, 6.4, TOK.bg);
    for (const [x, y] of [
      [7, 2],
      [8, 2],
      [13, 7],
      [13, 8],
      [7, 13],
      [8, 13],
      [2, 7],
      [2, 8],
    ])
      r.set(x, y, TOK.dim);
    r.line(8, 8, 8, 4, TOK.warn).line(8, 8, 11, 8, TOK.warn);
    r.rect(7, 7, 2, 2, TOK.ink);
  },
  escalation: (r) => {
    const cols = [TOK.ink, TOK.ink, TOK.warn, TOK.warn, TOK.threat];
    cols.forEach((c, i) => r.rect(1 + i * 3, 13 - (3 + i * 2), 2, 3 + i * 2, c));
    r.rect(0, 14, 16, 1, TOK.dim);
  },
  extraction: (r) => {
    r.ellipse(8, 7, 5.6, 7, TOK.ink);
    r.ellipse(8, 7, 4.4, 5.8, TOK.dim);
    r.draw(["..oo..", ".o..o.", "oooooo", "oMMMMo", "oMooMo", "oMMMMo"], { o: TOK.bg, M: TOK.money }, 5, 4);
    r.set(5, 2, TOK.ink).set(4, 4, TOK.ink);
    r.rect(7, 14, 2, 1, TOK.dim).rect(5, 15, 6, 1, TOK.dim);
  },
  unclassified: (r) =>
    r.draw(
      [
        "................",
        ".....IIIIII.....",
        "....IIIIIIII....",
        "...III....III...",
        "...III....III...",
        "..........III...",
        ".........III....",
        "........III.....",
        ".......III......",
        ".......III......",
        "................",
        ".......III......",
        ".......III......",
        "................",
      ],
      ICON_PAL,
      0,
      1,
    ),
};

const icon: Generator = (args, ctx) => {
  const draw = ICONS[String(args.cls)];
  return frames(ctx, (i, r) => draw?.(r, i));
};

// ── move icons ───────────────────────────────────────────────────────────────────────

const MOVES: Record<string, (r: Raster) => void> = {
  hold: (r) =>
    r.draw(
      [
        "................",
        "..oooooooooooo..",
        "..oFFFFFFFFFFo..",
        "..oFIIFFFFFFFo..",
        "..oFIFFFFFFFFo..",
        "..oFFFFFFFFFFo..",
        "..oFFFFFFFFFFo..",
        "..oFFFFFFFFFFo..",
        "..oFFFFFFFFFFo..",
        "...oFFFFFFFFo...",
        "...oFFFFFFFFo...",
        "....oFFFFFFo....",
        ".....oFFFFo.....",
        "......oFFo......",
        ".......oo.......",
        "................",
      ],
      ICON_PAL,
    ),
  flag: (r) =>
    r.draw(
      [
        "..I.............",
        "..IUUUUU.UUU....",
        "..IUUUUUUUUUUU..",
        "..IUUUUUUUUUUU..",
        "..IUUUUUUUUUUU..",
        "..IUUUUUUUUUUU..",
        "..IU...UUUUU....",
        "..I.............",
        "..I.............",
        "..I.............",
        "..I.............",
        "..I.............",
        "..I.............",
        ".III............",
        "IIIII...........",
      ],
      ICON_PAL,
      1,
      0,
    ),
  lockdown: (r) => {
    r.draw(
      [
        ".....HHHHHH.....",
        "....HHHHHHHH....",
        "...HHH....HHH...",
        "...HH......HH...",
        "...HH......HH...",
        "..HHHHHHHHHHHH..",
        "..HHHHHHHHHHHH..",
        "..HHHHHooHHHHH..",
        "..HHHHHooHHHHH..",
        "..HHHHHHoHHHHH..",
        "..HHHHHHoHHHHH..",
        "..HHHHHHHHHHHH..",
        "..HHHHHHHHHHHH..",
      ],
      ICON_PAL,
      0,
      1,
    );
  },
  breach: (r) =>
    r.draw(
      [
        ".......M........",
        ".M.....M.....M..",
        "..M....M....M...",
        "...M...y...M....",
        "....M.yyy.M.....",
        ".....yyyyy......",
        "MMMyyyyyyyyyMMM.",
        ".....yyyyy......",
        "....M.yyy.M.....",
        "...M...y...M....",
        "..M....M....M...",
        ".M.....M.....M..",
        ".......M........",
      ],
      ICON_PAL,
      0,
      2,
    ),
};

const move: Generator = (args, ctx) => frames(ctx, (_i, r) => MOVES[String(args.move)]?.(r));

// ── rank chevrons (16×10) ─────────────────────────────────────────────────────────────

const rank: Generator = (args, ctx) =>
  frames(ctx, (_i, r) => {
    const level = Math.max(0, Math.min(3, Number(args.level ?? 0)));
    if (level === 0) {
      r.rect(5, 3, 6, 2, TOK.dim);
      return;
    }
    const chev = ["...XX...", ".XXXXXX.", "XX....XX"];
    const total = 3 + 3 * (level - 1);
    const y0 = Math.floor((ctx.h - total) / 2);
    const x0 = level === 3 ? 0 : 4;
    for (let i = 0; i < level; i++) r.draw(chev, { X: level === 3 ? TOK.money : TOK.ink }, x0, y0 + i * 3);
    if (level === 3) r.draw(["..y..", ".yyy.", "yyyyy", ".yyy.", ".y.y."], { y: TOK.money }, 10, 2);
  });

// ── characters ───────────────────────────────────────────────────────────────────────

export type GuardKind = "bumbling" | "stern" | "bureaucratic" | "mocking" | "paranoid" | "support-bot";
export type GuardSpritePose = "idle" | "think" | "hold" | "flag" | "lockdown" | "breach";

export const GUARD_KINDS: readonly GuardKind[] = ["bumbling", "stern", "bureaucratic", "mocking", "paranoid", "support-bot"];
export const GUARD_POSES: Readonly<Record<GuardSpritePose, { frames: number; fps: number; loop: boolean }>> = {
  idle: { frames: 2, fps: 2, loop: true },
  think: { frames: 3, fps: 4, loop: true },
  hold: { frames: 1, fps: 1, loop: false },
  flag: { frames: 2, fps: 4, loop: false },
  lockdown: { frames: 3, fps: 6, loop: false },
  breach: { frames: 4, fps: 5, loop: false },
};

/** Fallback body when a guard's base tile is missing from the manifest. */
const FALLBACK_BODY = [
  "................",
  ".....oooooo.....",
  "....okkkkkko....",
  "...okkkkkkkko...",
  "...okknkknkko...",
  "...okkkkkkkko...",
  "....okkddkko....",
  ".....oooooo.....",
  "...oo2222222o...",
  "..o222222222o...",
  "..o2o22222o2o...",
  "..o2o22222o2o...",
  "..oko22222oko...",
  "...o2222222o....",
  "...o22o.o22o....",
  "...ooo...ooo....",
];

type Kit = {
  base: string;
  w: number;
  tileX: number;
  recolor?: Record<string, Color>;
  /** Headgear / props drawn in tile space (moves with bob and slump). */
  gear: (r: Raster, x: number, y: number, pose: GuardSpritePose, f: number) => void;
  /** Kind-specific lockdown (3 frames) in tile space. */
  lockdown: (r: Raster, x: number, y: number, f: number) => void;
};

const SKIN: Pal = { k: ART.skin, s: ART.skinMid, o: O };

const capRows = (droop: number) => [
  "....oooooooo....",
  "...oYYYYYYYYo...",
  "..oYYYYYYYYYYo..",
  "..oyyyyyyyyyyYo.",
  ...Array.from({ length: droop }, () => "..oyyyyyyyyyyYo."),
  "............oYo.",
  "............oYo.",
  ".............o..",
];
const CAP_PAL: Pal = { o: O, Y: ART.mustard, y: ART.mustardLight };

function lantern(r: Raster, x: number, y: number, lit = true) {
  r.draw([".oo.", "o..o", "oooo", "oyyo", "oYyo", "oooo"], { o: O, y: lit ? ART.yellow : ART.steel3, Y: lit ? ART.gold : ART.steel4 }, x, y);
}

function crossedArms(r: Raster, x: number, y: number, c: Color) {
  r.draw(["XX....XX", ".XX..XX.", "..XXXX..", ".XX..XX."], { X: c }, x + 4, y + 10);
}

function hood(r: Raster, x: number, y: number, low: number) {
  const top = [
    "......ooooo.....",
    "....ooHHHHHoo...",
    "...oHHhhhhhHHo..",
    "..oHhhhhhhhhhHo.",
    ".oHhhhhhhhhhhhHo",
  ];
  const fill = Array.from({ length: low }, () => ".oHhhhhhhhhhhhHo");
  const sides = [".oHh........hHo.", ".oHh........hHo.", ".oHh........hHo.", ".oHH........HHo.", ".ooHH......HHoo.", "..ooHH....HHoo.."];
  r.draw([...top, ...fill, ...sides.slice(Math.min(low, 4))], { o: O, H: ART.marsh, h: ART.marshLight }, x, y);
}

function grin(r: Raster, x: number, y: number) {
  r.draw(["o....o", "owwwwo"], { o: O, w: ART.white }, x + 5, y + 8);
}

function clipboard(r: Raster, x: number, y: number, stamped = false) {
  r.draw(["..1..", "bb1bb", "bPPPb", "bdddb", "bPPPb", "bdddb", "bbbbb"], { "1": ART.steel1, b: ART.brown, P: ART.parchment, d: ART.brownDark }, x, y);
  if (stamped) r.draw(["H...H", ".H.H.", "..H..", ".H.H.", "H...H"], { H: TOK.threat }, x, y + 1);
}

function visorCap(r: Raster, x: number, y: number) {
  r.draw(["..o3333333333o..", "..oGGGGGGGGGGo..", "...oGGGGGGGGo..."], { o: O, "3": ART.steel3, G: ART.green }, x, y + 3);
}

function headset(r: Raster, x: number, y: number) {
  r.draw(
    ["....nnnnnnnn....", "...n........n...", "..n..........n..", "..n..........n..", "..n..........n..", ".nn..........nn.", ".nt..........tn.", ".nn..........nn.", "..n.............", "..nnnt.........."],
    { n: ART.navy, t: ART.teal },
    x,
    y,
  );
}

function spear(r: Raster, x: number, y: number) {
  r.draw(["..1.", ".111", ".121", "..2."], { "1": ART.steel1, "2": ART.steel2 }, x + 12, y - 1);
  r.rect(x + 14, y + 3, 1, 13, ART.brownDark);
}

function pauldrons(r: Raster, x: number, y: number) {
  const L = ["...oooo", ".oo2222", "o222333", "o233333", "o333333", ".oooooo"];
  const R = L.map((row) => [...row].reverse().join(""));
  r.draw(L, { o: O, "2": ART.steel3, "3": ART.steel4 }, x - 4, y + 9);
  r.draw(R, { o: O, "2": ART.steel3, "3": ART.steel4 }, x + 13, y + 9);
}

function eyeSlit(r: Raster, x: number, y: number, level: 0 | 1 | 2) {
  const c = level === 2 ? ART.redBright : ART.red;
  r.rect(x + 5, y + 7, 6, 1, level === 0 ? "#8a2a22" : c);
  if (level === 2) r.set(x + 7, y + 7, ART.white).set(x + 8, y + 7, ART.white);
}

function glass(r: Raster, dx: number, h = 12) {
  for (let y = 0; y < h; y++) for (let x = Math.max(0, dx); x < 16; x++) r.set(x, y, ART.glass, 0.16);
  if (dx < 16) {
    r.line(dx + 10, 1, dx + 13, 4, ART.white, 0.55);
    r.line(dx + 12, 1, dx + 14, 3, ART.white, 0.4);
    r.rect(Math.max(0, dx), 0, 16, 1, ART.steel1, 0.8);
  }
}

function counter(r: Raster) {
  r.rect(0, 12, 16, 1, ART.white).rect(0, 13, 16, 2, ART.green).rect(0, 15, 16, 1, O);
  r.rect(2, 13, 3, 1, ART.teal);
}

const KITS: Record<GuardKind, Kit> = {
  bumbling: {
    base: "tile_0086",
    w: 16,
    tileX: 0,
    gear: (r, x, y, pose, f) => {
      const slump = pose === "breach" && f >= 3;
      r.draw(capRows(0), CAP_PAL, x + (slump ? 1 : 0), y + (slump ? 1 : 0));
      if (pose !== "hold") lantern(r, x, y + 9, pose !== "breach" || f < 2);
    },
    lockdown: (r, x, y, f) => {
      r.draw(capRows(f + 1), CAP_PAL, x, y);
      if (f >= 1) crossedArms(r, x, y, ART.skin);
    },
  },
  stern: {
    base: "tile_0096",
    w: 16,
    tileX: 0,
    gear: (r, x, y, pose) => {
      r.draw([".....gggggg.....", ".....gGGGGg....."], { g: ART.green, G: ART.greenLight }, x, y + 11);
      if (pose !== "hold" && pose !== "flag") spear(r, x, y);
    },
    lockdown: (r, x, y, f) => {
      r.rect(x + 5, y + 7, 6, 1, f === 0 ? ART.gold : ART.red);
      if (f >= 1) crossedArms(r, x, y, ART.steel2);
      if (f === 2) r.set(x + 7, y + 7, ART.white).set(x + 8, y + 7, ART.white);
      spear(r, x, y);
    },
  },
  bureaucratic: {
    base: "tile_0085",
    w: 16,
    tileX: 0,
    gear: (r, x, y, pose) => {
      visorCap(r, x, y);
      if (pose !== "hold" && pose !== "flag") clipboard(r, x + 11, y + 8);
    },
    lockdown: (r, x, y, f) => {
      visorCap(r, x, y);
      if (f === 0) clipboard(r, x + 11, y + 6);
      else if (f === 1) clipboard(r, x + 8, y + 3);
      else clipboard(r, x + 6, y + 7, true);
    },
  },
  mocking: {
    base: "tile_0112",
    w: 16,
    tileX: 0,
    recolor: { "#25956a": ART.marsh, "#43e1b3": ART.ember },
    gear: (r, x, y, pose, f) => {
      hood(r, x, y, 0);
      if (pose !== "breach" || f < 2) grin(r, x, y);
    },
    lockdown: (r, x, y, f) => {
      hood(r, x, y, f + 1);
      grin(r, x, y);
      if (f === 2) r.set(x + 6, y + 7, ART.ember).set(x + 9, y + 7, ART.ember);
    },
  },
  paranoid: {
    base: "tile_0096",
    w: 24,
    tileX: 4,
    recolor: { "#c0cbdc": ART.steel2, "#8b9bb4": ART.steel3, "#52607c": ART.steel4, "#bd6c4a": ART.red },
    gear: (r, x, y, pose) => {
      pauldrons(r, x, y);
      eyeSlit(r, x, y, pose === "think" || pose === "flag" ? 1 : pose === "breach" ? 0 : 1);
    },
    lockdown: (r, x, y, f) => {
      pauldrons(r, x, y);
      eyeSlit(r, x, y, f === 0 ? 1 : 2);
      if (f >= 1) crossedArms(r, x, y, ART.steel3);
      if (f === 2) r.box(0, 0, 24, 16, TOK.threat, 0.8);
    },
  },
  "support-bot": {
    base: "tile_0099",
    w: 16,
    tileX: 0,
    recolor: { "#9b4ca3": ART.green, "#d176d0": ART.teal },
    gear: (r, x, y) => headset(r, x, y),
    lockdown: (r, x, y) => headset(r, x, y),
  },
};

function characterBase(ctx: GenCtx, tileId: string | undefined, recolor?: Record<string, Color>): Raster {
  const tile = tileId ? ctx.tiles[tileId] : undefined;
  const r = tile ? tileRaster(tile) : new Raster(16, 16).draw(FALLBACK_BODY, { o: O, k: ART.skin, n: ART.navy, d: ART.brownDark, "2": ART.steel2 });
  return recolor ? r.recolor(recolor) : r;
}

function thoughtDots(r: Raster, w: number, n: number) {
  const spots: [number, number, number][] = [
    [w - 5, 3, 1],
    [w - 3, 1, 1],
    [w - 2, 0, 2],
  ];
  spots.slice(0, n).forEach(([x, y, s]) => r.rect(x, y, s, 1, TOK.ink));
}

function flagBadge(r: Raster, w: number) {
  r.draw(["oUUUo", "UUoUU", "UUoUU", "UUUUU", "UUoUU"], { o: TOK.bg, U: TOK.warn }, w - 6, 0);
}

function palm(r: Raster, x: number, y: number) {
  r.draw([".k.k", ".kkk", "okkk", "okks", ".oo."], SKIN, x + 12, y + 5);
}

function pointing(r: Raster, x: number, y: number) {
  r.draw(["ooo.", "kkko", "oo.."], SKIN, x + 13, y + 8);
}

function sweat(r: Raster, x: number, y: number) {
  r.set(x + 12, y + 3, ART.sweat).set(x + 12, y + 4, ART.sweat).set(x + 11, y + 4, ART.sweat, 0.7);
}

const guard: Generator = (args, ctx) => {
  const kind = (GUARD_KINDS as readonly string[]).includes(String(args.kind)) ? (args.kind as GuardKind) : "stern";
  const pose = (Object.keys(GUARD_POSES) as GuardSpritePose[]).includes(args.pose as GuardSpritePose) ? (args.pose as GuardSpritePose) : "idle";
  const kit = KITS[kind];
  const base = characterBase(ctx, ctx.base ?? kit.base, kit.recolor);
  const W = ctx.w;
  return frames(ctx, (f, r) => {
    const bot = kind === "support-bot";
    let dy = 0;
    if (pose === "idle") dy = f % 2;
    if (pose === "breach") dy = bot ? [0, 1, 1, 2][f] : f + 1;
    const x = kit.tileX;
    r.paste(base, x, dy);
    if (pose === "lockdown") kit.lockdown(r, x, dy, f);
    else kit.gear(r, x, dy, pose, f);

    if (pose === "think") thoughtDots(r, W, f + 1);
    if (pose === "hold") {
      palm(r, x, dy);
      r.box(0, 0, W, ctx.h, TOK.safe, 0.85);
    }
    if (pose === "flag") {
      pointing(r, x, dy);
      if (f >= 1) flagBadge(r, W);
    }
    if (pose === "breach" && f >= 1 && !bot) sweat(r, x, dy);

    if (bot) {
      counter(r);
      if (pose === "breach") glass(r, f * 4);
      else if (pose === "lockdown") {
        glass(r, 0);
        const rows = [4, 8, 12][f];
        for (let yy = 0; yy < rows; yy++) r.rect(0, yy, 16, 1, yy % 3 === 2 ? O : yy % 3 === 0 ? ART.steel2 : ART.steel3);
        if (f === 2) r.rect(0, 5, 16, 2, TOK.threat);
      } else glass(r, 0);
      if (pose === "hold") r.box(0, 0, W, ctx.h, TOK.safe, 0.85);
    }
  });
};

/** The hooded operator (raider agents): idle bob, typing dots while thinking. */
const operator: Generator = (args, ctx) => {
  const base = characterBase(ctx, ctx.base ?? "tile_0111");
  return frames(ctx, (f, r) => {
    const dy = args.pose === "idle" ? f % 2 : 0;
    r.paste(base, 0, dy);
    // laptop seen from behind, its glow on the hood
    r.draw(["...oooooooooo...", "...o33333333o...", "...o333A3333o...", "..oooooooooooo.."], { o: O, "3": ART.steel3, A: TOK.accent }, 0, 12);
    r.set(4, 9 + dy, TOK.accent, 0.5).set(11, 9 + dy, TOK.accent, 0.5);
    if (args.pose === "think") for (let i = 0; i <= f; i++) r.set(6 + i * 2, 10, TOK.accent);
  });
};

/** Draws a manifest tile from its embedded pixels (fallback for PNG sprites). */
const tileGen: Generator = (args, ctx) => {
  const tile = ctx.tiles[String(args.tile ?? ctx.base ?? "")];
  return frames(ctx, (_i, r) => (tile ? r.paste(tileRaster(tile)) : missingArt(r)));
};

function missingArt(r: Raster) {
  r.box(0, 0, r.w, r.h, TOK.threat);
  r.draw(["HH.", "..H", ".H.", "...", ".H."], { H: TOK.threat }, Math.floor(r.w / 2) - 1, Math.floor(r.h / 2) - 3);
}

const missing: Generator = (_a, ctx) => frames(ctx, (_i, r) => missingArt(r));

export const GENERATORS: Readonly<Record<string, Generator>> = {
  "door.closed": doorClosed,
  "door.shaking": doorShaking,
  "door.open": doorOpen,
  shutter,
  packet,
  coin,
  clock,
  inbox,
  mirror,
  padlock: padlockGen,
  credential,
  radio,
  pager,
  static: staticFx,
  icon,
  move,
  rank,
  guard,
  operator,
  tile: tileGen,
  missing,
};

export function hasGenerator(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(GENERATORS, name);
}

/** Render a generator to a strip SVG (tokens unresolved). Unknown generators draw the "missing" box. */
export function renderGenerator(name: string, args: GenArgs, ctx: GenCtx): string {
  const gen = GENERATORS[name] ?? missing;
  let out: Raster[];
  try {
    out = gen(args, ctx);
  } catch {
    out = missing(args, ctx);
  }
  return stripSvg(out, ctx.w, ctx.h);
}
