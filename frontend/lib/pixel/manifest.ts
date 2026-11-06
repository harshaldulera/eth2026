import raw from "@/public/pixel/manifest.json";
import { renderGenerator, resolveTokens, svgDataUri, type GenArgs, type GuardKind, type GuardSpritePose, type TileData } from "./sprite";

/**
 * Sprite manifest (plan §2.4): public/pixel/manifest.json maps a sprite name to either PNG art
 * (`src`: one horizontal strip, or one file per frame) or a code generator (`svg`, in
 * lib/pixel/sprite.ts). Every PNG entry also names a generator, used when the image fails to load.
 * The JSON is bundled (no fetch, SSR-safe); `loadManifest()` re-reads the served copy for tools.
 */

type Common = { w: number; h: number; frames: number; fps?: number; loop?: boolean; args?: GenArgs; base?: string };
export type GenEntry = Common & { svg: string; src?: undefined };
export type SrcEntry = Common & { src: string | string[]; svg?: string };
export type ManifestEntry = GenEntry | SrcEntry;
export type Manifest = { version: 1; tileSize: number; note?: string; sprites: Record<string, ManifestEntry>; tiles: Record<string, TileData> };

export type ManifestProblem = { sprite: string; problem: string };

/** Structural check (tests and loadManifest). File existence is checked by the manifest test. */
export function validateManifest(m: unknown): ManifestProblem[] {
  const out: ManifestProblem[] = [];
  const mm = m as Partial<Manifest> | null;
  if (!mm || typeof mm !== "object" || !mm.sprites || typeof mm.sprites !== "object") return [{ sprite: "*", problem: "no sprites" }];
  for (const [name, e] of Object.entries(mm.sprites)) {
    const bad = (problem: string) => out.push({ sprite: name, problem });
    if (!e || typeof e !== "object") {
      bad("not an object");
      continue;
    }
    if (!(Number.isInteger(e.w) && e.w > 0 && Number.isInteger(e.h) && e.h > 0)) bad("w/h must be positive integers");
    if (!(Number.isInteger(e.frames) && e.frames >= 1)) bad("frames must be ≥ 1");
    if (e.fps !== undefined && !(e.fps > 0)) bad("fps must be > 0");
    if (!e.src && !e.svg) bad("needs src or svg");
    if (Array.isArray(e.src) && e.src.length !== e.frames) bad("src[] length must equal frames");
    if (e.base && !mm.tiles?.[e.base]) bad(`base tile ${e.base} missing from tiles`);
  }
  for (const [id, t] of Object.entries(mm.tiles ?? {})) {
    if (t.rows?.length !== t.h || t.rows.some((r) => r.length !== t.w)) out.push({ sprite: `tiles.${id}`, problem: "rows do not match w×h" });
  }
  return out;
}

let current: Manifest = raw as unknown as Manifest;

export function getManifest(): Manifest {
  return current;
}

export function getSprite(name: string): ManifestEntry | undefined {
  return Object.prototype.hasOwnProperty.call(current.sprites, name) ? current.sprites[name] : undefined;
}

export function spriteNames(): string[] {
  return Object.keys(current.sprites);
}

/** Fetch the served manifest and use it (keeps the bundled one if the fetch or validation fails). */
export async function loadManifest(url = "/pixel/manifest.json", f: typeof fetch = fetch): Promise<Manifest> {
  try {
    const res = await f(url);
    if (!res.ok) return current;
    const json = (await res.json()) as unknown;
    if (validateManifest(json).length === 0) current = json as Manifest;
  } catch {
    /* keep the bundled manifest */
  }
  return current;
}

const svgCache = new Map<string, string>();

/**
 * The generator strip for a sprite as an SVG string (tokens unresolved), memoised. PNG entries
 * render their fallback generator; unknown names render the "missing" box.
 */
export function spriteSvg(name: string): string {
  const hit = svgCache.get(name);
  if (hit) return hit;
  const e = getSprite(name);
  const svg = e
    ? renderGenerator(e.svg ?? "missing", e.args ?? {}, { w: e.w, h: e.h, frames: e.frames, tiles: current.tiles, base: e.base })
    : renderGenerator("missing", {}, { w: 16, h: 16, frames: 1, tiles: current.tiles });
  svgCache.set(name, svg);
  return svg;
}

const uriCache = new Map<string, string>();

/** Data URI of a generator strip with skin tokens resolved (`tokensKey` identifies the token set). */
export function spriteDataUri(name: string, tokens?: Readonly<Record<string, string>> | null, tokensKey = ""): string {
  const key = `${name}\u0000${tokensKey}`;
  const hit = uriCache.get(key);
  if (hit) return hit;
  const uri = svgDataUri(resolveTokens(spriteSvg(name), tokens));
  if (uriCache.size > 600) uriCache.clear();
  uriCache.set(key, uri);
  return uri;
}

// ─── guards ────────────────────────────────────────────────────────────────────────────

/**
 * Which portrait a castle gets: SDK guards are Penny's support bot; hosted guards follow their
 * personality preset (unknown presets get the stern knight).
 */
export function guardKind(c: { personality?: string | null; transport?: string | null; guardianName?: string | null }): GuardKind {
  if (c.transport === "sdk" || /support bot/i.test(c.guardianName ?? "")) return "support-bot";
  const p = (c.personality ?? "").toLowerCase();
  if (p === "bumbling" || p === "stern" || p === "bureaucratic" || p === "mocking" || p === "paranoid") return p;
  return "stern";
}

export type GuardScenePose = "idle" | "alert" | "thinking" | "hold" | "flag" | "lockdown" | "breach";

const POSE_SPRITE: Record<GuardScenePose, GuardSpritePose> = {
  idle: "idle",
  alert: "idle",
  thinking: "think",
  hold: "hold",
  flag: "flag",
  lockdown: "lockdown",
  breach: "breach",
};

/**
 * Sprite name + animation for a guard in a scene pose (SceneFrame.guard).
 *
 * @example const g = guardSprite(guardKind(castle), frame.guard); <Sprite name={g.name} animate={g.animate} />
 */
export function guardSprite(kind: GuardKind, pose: GuardScenePose): { name: string; animate: { fps: number; loop: boolean } } {
  const name = `guard.${kind}.${POSE_SPRITE[pose] ?? "idle"}`;
  const e = getSprite(name);
  const fps = pose === "alert" ? 4 : (e?.fps ?? 2);
  return { name, animate: { fps, loop: e?.loop ?? true } };
}
