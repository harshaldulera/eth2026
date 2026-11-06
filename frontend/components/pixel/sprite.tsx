"use client";

import { useEffect, useMemo, useState, useSyncExternalStore, type CSSProperties } from "react";
import { getSprite, spriteDataUri, type ManifestEntry } from "@/lib/pixel/manifest";
import { TOKEN_NAMES } from "@/lib/pixel/sprite";
import { usePixelScale } from "@/lib/pixel/scale";
import { useCalmMotion } from "@/lib/hooks/usePrefs";

/**
 * A pixel sprite from public/pixel/manifest.json (plan §2.4).
 *
 * Renders a <span> whose background is the sprite's frame strip, scaled by an integer factor and
 * drawn `pixelated`. `animate` steps through the frames with CSS `steps()` (no JS timers); loops
 * repeat, one-shots (breach, shutter, door opening) stop on their last frame. Reduced motion shows
 * a still frame (the last one for one-shots). PNG sprites fall back to their code generator if the
 * image fails to load. Code-drawn sprites pick up the live skin's colours.
 *
 * @example <Sprite name="guard.bumbling.idle" animate />
 * @example <Sprite name="door.open" animate={{ fps: 6, loop: false }} onAnimationEnd={() => setOpened(true)} />
 */
export type SpriteProps = {
  name: string;
  /** Still frame (0-based) when not animating. */
  frame?: number;
  /** Integer scale; defaults to usePixelScale() (2 phone / 3 desktop / 4 wall). */
  scale?: number;
  /** true = manifest fps/loop; or override them. */
  animate?: boolean | { fps?: number; loop?: boolean };
  className?: string;
  style?: CSSProperties;
  /** Accessible name; without it the sprite is decorative (aria-hidden). */
  label?: string;
  onAnimationEnd?: () => void;
};

const CSS = `.siege-sprite{display:inline-block;flex:none;position:relative;overflow:hidden;background-repeat:no-repeat;image-rendering:pixelated;vertical-align:middle}
.siege-sprite>span{display:flex;height:100%}
.siege-sprite>span>span{flex:none;height:100%;background-repeat:no-repeat;background-size:100% 100%;image-rendering:pixelated}
@keyframes siege-sprite-run{from{background-position-x:0}to{background-position-x:var(--sprite-end)}}
@keyframes siege-sprite-cells{from{transform:translateX(0)}to{transform:translateX(var(--sprite-end))}}
@media (prefers-reduced-motion:reduce){.siege-sprite,.siege-sprite *{animation:none!important}}
html[data-calm="1"] .siege-sprite,html[data-calm="1"] .siege-sprite *{animation:none!important}`;

// ─── live skin tokens (an SVG image cannot read the page's CSS variables) ─────────────────

const tokenCache = new Map<string, Record<string, string>>();

function subscribeSkin(cb: () => void) {
  if (typeof MutationObserver === "undefined") return () => {};
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-skin"] });
  return () => mo.disconnect();
}
const skinSnapshot = () => document.documentElement.getAttribute("data-skin") ?? "default";
const serverSkin = () => null;

function tokensFor(skin: string | null): Record<string, string> | null {
  if (skin === null || typeof window === "undefined") return null;
  const hit = tokenCache.get(skin);
  if (hit) return hit;
  const cs = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (const n of TOKEN_NAMES) {
    const v = cs.getPropertyValue(n).trim();
    if (v) out[n] = v;
  }
  tokenCache.set(skin, out);
  return out;
}

// ─── PNG failure tracking ─────────────────────────────────────────────────────────────────

const failedSrc = new Set<string>();
const okSrc = new Set<string>();

function srcList(e: ManifestEntry | undefined): string[] {
  if (!e?.src) return [];
  return Array.isArray(e.src) ? e.src : [e.src];
}

function useSrcFailed(srcs: string[]): boolean {
  const key = srcs.join("|");
  // bumped when an image fails, so the render below re-reads failedSrc
  const [, setFailures] = useState(0);
  useEffect(() => {
    const list = key ? key.split("|") : [];
    let live = true;
    for (const s of list) {
      if (okSrc.has(s) || failedSrc.has(s)) continue;
      const img = new Image();
      img.onload = () => okSrc.add(s);
      img.onerror = () => {
        failedSrc.add(s);
        if (live) setFailures((n) => n + 1);
      };
      img.src = s;
    }
    return () => {
      live = false;
    };
  }, [key]);
  return srcs.some((s) => failedSrc.has(s));
}

export function Sprite({ name, frame = 0, scale: scaleProp, animate, className, style, label, onAnimationEnd }: SpriteProps) {
  const entry = getSprite(name);
  const autoScale = usePixelScale();
  const scale = Math.max(1, Math.round(scaleProp ?? autoScale));
  const skin = useSyncExternalStore(subscribeSkin, skinSnapshot, serverSkin);
  const calm = useCalmMotion();
  const srcs = srcList(entry);
  const failed = useSrcFailed(srcs);
  const usePng = srcs.length > 0 && !failed;

  const w = entry?.w ?? 16;
  const h = entry?.h ?? 16;
  const n = Math.max(1, entry?.frames ?? 1);
  const fw = w * scale;
  const fh = h * scale;

  const anim = animate ? { fps: (typeof animate === "object" ? animate.fps : undefined) ?? entry?.fps ?? 4, loop: (typeof animate === "object" ? animate.loop : undefined) ?? entry?.loop ?? true } : null;
  const running = Boolean(anim && n > 1 && !calm);
  // Reduced motion: a one-shot shows where it would have ended.
  const still = anim && !anim.loop && n > 1 && calm ? n - 1 : Math.min(Math.max(0, Math.floor(frame)), n - 1);

  const generated = useMemo(() => (usePng ? null : spriteDataUri(name, tokensFor(skin), skin ?? "")), [name, skin, usePng]);

  const a11y = label ? { role: "img" as const, "aria-label": label } : { "aria-hidden": true as const };
  const box: CSSProperties = { width: fw, height: fh, ...style };
  const timing = anim ? (anim.loop ? `steps(${n}) infinite` : `steps(${n}, jump-none) 1 forwards`) : "";
  const durMs = anim ? Math.round((n / Math.max(0.1, anim.fps)) * 1000) : 0;
  const endPx = anim ? -(anim.loop ? n : n - 1) * fw : 0;

  const styleTag = (
    <style href="siege-sprite" precedence="medium">
      {CSS}
    </style>
  );

  // One PNG per frame: a row of cells slid by transform.
  if (usePng && Array.isArray(entry?.src)) {
    const cells = entry.src;
    return (
      <>
        {styleTag}
        <span key={name} className={["siege-sprite", className].filter(Boolean).join(" ")} style={box} {...a11y}>
          <span
            style={{
              width: fw * n,
              transform: `translateX(${-still * fw}px)`,
              ...(running ? ({ "--sprite-end": `${endPx}px`, animation: `siege-sprite-cells ${durMs}ms ${timing}` } as CSSProperties) : null),
            }}
            onAnimationEnd={onAnimationEnd}
          >
            {cells.map((src) => (
              <span key={src} style={{ width: fw, backgroundImage: `url("${src}")` }} />
            ))}
          </span>
        </span>
      </>
    );
  }

  const image = usePng ? `url("${srcs[0]}")` : `url("${generated}")`;
  return (
    <>
      {styleTag}
      <span
        key={name}
        className={["siege-sprite", className].filter(Boolean).join(" ")}
        style={{
          ...box,
          backgroundImage: image,
          backgroundSize: `${fw * n}px ${fh}px`,
          backgroundPosition: `${-still * fw}px 0px`,
          ...(running ? ({ "--sprite-end": `${endPx}px`, animation: `siege-sprite-run ${durMs}ms ${timing}` } as CSSProperties) : null),
        }}
        onAnimationEnd={onAnimationEnd}
        data-sprite={name}
        {...a11y}
      />
    </>
  );
}
