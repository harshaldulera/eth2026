"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api/client";
import { useConfig } from "@/lib/hooks/useConfig";
import { useEventFeed } from "@/lib/hooks/useEventFeed";
import { useNow, usePolling } from "@/lib/hooks/usePolling";
import { useCalmMotion } from "@/lib/hooks/usePrefs";
import { useSfx } from "@/lib/sfx/useSfx";
import { playCue } from "@/components/pixel/sfx-link";
import { LED } from "@/components/pixel";
import { cn } from "@/lib/utils";
import { ROTATION, SLIDE_TITLE, deckReducer, elapsed, initialDeck, slideParam, type Availability, type DeckState } from "./deck";
import { BreachStrip, GridSlide, NoLiveOp, OpSlide, PagerSlide, SeasonSlide } from "./slides";

/** The wall is drawn on a 1920×1080 canvas and scaled to fit whatever screen it is on. */
const W = 1920;
const H = 1080;

function subscribeResize(cb: () => void) {
  window.addEventListener("resize", cb);
  return () => window.removeEventListener("resize", cb);
}
const fitScale = () => Math.min(window.innerWidth / W, window.innerHeight / H);

/** Hydration-safe fit: 1 on the server and the first client render, then the real ratio. */
function useFit(): number {
  return React.useSyncExternalStore(subscribeResize, fitScale, () => 1);
}

function editable(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");
}

/** Wall-only CSS: no cursor, quieter scanlines (0.08), the CRT power-on wipe each slide enters with. */
const WALL_CSS = `
html[data-wall-on],html[data-wall-on] *{cursor:none!important}
html[data-wall-on]{overflow:hidden}
html[data-wall-on] [data-crt-overlay]{--scan-alpha:0.08}
html[data-wall-on] nextjs-portal{display:none!important}
[data-wall-scene]>div>header{display:none}
[data-wall-ticker] [aria-label^="stub "],[data-wall-ticker] a[target=_blank]{display:none}
[data-wall-scene=bare]>div{padding-top:16px}
[data-wall-scene=interrupt]>div{padding-top:8px}
[data-wall] [role=log]{-webkit-mask-image:linear-gradient(to bottom,transparent 0,black 56px);mask-image:linear-gradient(to bottom,transparent 0,black 56px)}
@keyframes wall-power-on{
  0%{transform:scale(0,.004);filter:brightness(4);opacity:1}
  45%{transform:scale(1,.004);filter:brightness(3);opacity:1}
  100%{transform:scale(1,1);filter:brightness(1);opacity:1}
}
.wall-wipe{animation:wall-power-on 400ms cubic-bezier(.2,.7,.2,1) both;transform-origin:50% 50%}
@keyframes wall-fill{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@media (prefers-reduced-motion:reduce){.wall-wipe{animation:none}}
html[data-calm="1"] .wall-wipe{animation:none}
`;

/**
 * The spectator wall (design §3.8): 1920×1080, no controls, cursor hidden. Slides on one timer:
 * LIVE OP → THE GRID → LAST BREACH → SEASON → PAGER MIRROR. A breach in the global feed preempts
 * for 25 s, a lockdown for 8 s. Space pauses, `n` skips. Sound only with `?sound=1` (and after one
 * click, which browsers require). `?slide=season` starts on a given slide.
 */
export function WallView() {
  const params = useSearchParams();
  const sound = params.get("sound") === "1";
  const first = slideParam(params.get("slide")) ?? "grid";
  const startPaused = params.get("paused") === "1";
  const calm = useCalmMotion();
  const fit = useFit();
  const { config } = useConfig();
  const sfx = useSfx();

  const stats = usePolling(() => api.stats(), 3_000);
  const approvals = usePolling(() => api.approvals("pending"), 3_000);
  const pending = approvals.data?.approvals ?? [];

  const avail: Availability = React.useMemo(
    () => ({
      liveId: stats.data?.live[0]?.siegeId ?? null,
      breachId: stats.data?.breaches[0]?.siegeId ?? null,
      pending: pending.length > 0,
      ready: stats.data !== undefined && approvals.data !== undefined,
    }),
    [stats.data, pending.length, approvals.data],
  );

  const [deck, dispatch] = React.useReducer(deckReducer, undefined, () => initialDeck(-1, first, startPaused));

  // One timer drives the rotation.
  const onTick = React.useEffectEvent(() => dispatch({ type: "tick", now: Date.now(), avail }));
  React.useEffect(() => {
    onTick();
    const t = setInterval(onTick, 250);
    return () => clearInterval(t);
  }, []);

  // Keys: space pauses, n (or →) skips. Nothing else: the wall has no controls.
  const onKey = React.useEffectEvent((e: KeyboardEvent) => {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || editable(e.target)) return;
    if (e.key === " ") {
      e.preventDefault();
      dispatch({ type: "toggle", now: Date.now() });
    } else if (e.key === "n" || e.key === "N" || e.key === "ArrowRight") {
      dispatch({ type: "next", now: Date.now(), avail });
    }
  });
  React.useEffect(() => {
    const h = (e: KeyboardEvent) => onKey(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // Interrupts from the global feed: only events that arrive after the wall came up.
  const feed = useEventFeed({ tail: true, limit: 40, intervalMs: 1_500 });
  const seen = React.useRef<number | null>(null);
  // The page-wide wall rules (no cursor, no scroll, quiet scanlines) hang off <html data-wall-on>,
  // set only while the wall is on screen: Activity keeps a hidden /wall mounted after Back, and an
  // :has([data-wall]) selector would keep hiding the cursor on whatever page comes next. On hide we
  // also forget the feed position, so coming back doesn't replay every end event missed meanwhile.
  React.useLayoutEffect(() => {
    const html = document.documentElement;
    html.setAttribute("data-wall-on", "");
    return () => {
      html.removeAttribute("data-wall-on");
      seen.current = null;
    };
  }, []);
  const onEvents = React.useEffectEvent(() => {
    if (!feed.ready) return;
    const newest = feed.events.at(-1)?.id ?? 0;
    if (seen.current === null) {
      seen.current = newest;
      return;
    }
    const fresh = feed.events.filter((e) => e.id > (seen.current ?? 0));
    seen.current = Math.max(seen.current, newest);
    for (const e of fresh) {
      if (e.type !== "end" || !e.siegeId) continue;
      const st = e.payload?.status;
      if (st === "broken") dispatch({ type: "interrupt", kind: "breach", siegeId: e.siegeId, now: Date.now() });
      else if (st === "banished") dispatch({ type: "interrupt", kind: "lockdown", siegeId: e.siegeId, now: Date.now() });
    }
  });
  React.useEffect(() => onEvents(), [feed.events, feed.ready]);

  // The click that unlocks audio powers the wall on (design §8, 0:00): power_on once, only with ?sound=1.
  const powered = React.useRef(false);
  const unlocked = sfx.unlocked;
  React.useEffect(() => {
    if (!sound || !unlocked || powered.current) return;
    powered.current = true;
    playCue("power_on");
  }, [sound, unlocked]);

  // A soft blip on each slide change (only with ?sound=1).
  const seq = deck.slide.seq;
  React.useEffect(() => {
    if (sound && seq > 0) playCue("wall_rotate");
  }, [sound, seq]);

  const done = React.useCallback(() => dispatch({ type: "done", seq }), [seq]);
  const slide = deck.slide;

  let body: React.ReactNode;
  switch (slide.kind) {
    case "live":
      body = slide.siegeId ? (
        <OpSlide key={slide.siegeId} siegeId={slide.siegeId} mode="live" sound={sound} calm={calm} onDone={done} interrupt={slide.interrupt} />
      ) : avail.ready ? (
        <NoLiveOp />
      ) : null;
      break;
    case "op":
    case "breach":
      body = slide.siegeId ? <OpSlide key={`${slide.siegeId}:${slide.seq}`} siegeId={slide.siegeId} mode="replay" sound={sound} calm={calm} interrupt={slide.interrupt} /> : null;
      break;
    case "grid":
      body = <GridSlide stats={stats.data} />;
      break;
    case "season":
      body = <SeasonSlide stats={stats.data} />;
      break;
    case "pager":
      body = <PagerSlide approvals={pending} />;
      break;
  }

  return (
    <div data-wall="" className="fixed inset-0 z-20 overflow-hidden bg-bg" aria-label="Siege spectator wall">
      <style href="siege-wall" precedence="default">
        {WALL_CSS}
      </style>
      <div
        className="absolute top-1/2 left-1/2 flex flex-col bg-bg"
        style={{ width: W, height: H, transform: `translate(-50%, -50%) scale(${fit})` }}
      >
        {slide.kind === "breach" ? (
          <BreachStrip b={stats.data?.breaches.find((b) => b.siegeId === slide.siegeId)} />
        ) : null}
        <div key={slide.seq} className={cn("min-h-0 flex-1", !calm && "wall-wipe")}>
          {body}
        </div>
        <WallBar deck={deck} stub={config ? config.chain.mode !== "testnet" : undefined} offline={Boolean(stats.error && !stats.data)} soundHint={sound && !sfx.unlocked} />
      </div>
    </div>
  );
}

const BAR_SLIDES = ROTATION;

/** The bottom strip: wordmark, which slide is up (with its clock), PAUSED, the mode light. */
function WallBar({ deck, stub, offline, soundHint }: { deck: DeckState; stub?: boolean; offline: boolean; soundHint: boolean }) {
  const now = useNow(250);
  const k = deck.slide.kind === "op" ? "live" : deck.slide.kind;
  const p = now && deck.maxMs ? Math.min(1, elapsed(deck, now) / deck.maxMs) : 0;
  return (
    <footer className="flex h-[64px] shrink-0 items-center gap-8 border-t-4 border-line bg-panel px-12">
      <span className="font-pixel text-[28px] leading-none text-accent glow">SIEGE</span>
      <ol className="flex flex-1 items-stretch gap-2" aria-label="Wall slides">
        {BAR_SLIDES.map((s) => (
          <li
            key={s}
            aria-current={s === k ? "true" : undefined}
            className={cn("relative px-4 py-2 font-ui text-[24px] leading-none tracking-[0.1em]", s === k ? "bg-raised text-ink" : "text-ink-dim/60")}
          >
            {SLIDE_TITLE[s]}
            {s === k ? <span className="absolute inset-x-0 bottom-0 h-1 origin-left bg-accent" style={{ transform: `scaleX(${p})` }} aria-hidden /> : null}
          </li>
        ))}
      </ol>
      {soundHint ? <span className="font-ui text-[24px] tracking-[0.1em] text-warn">CLICK ONCE FOR SOUND</span> : null}
      {deck.paused ? <span className="animate-blink font-pixel text-[24px] text-warn">PAUSED</span> : null}
      {offline ? (
        <LED kind="offline" className="text-[24px] [&>span:first-child]:size-4" />
      ) : stub === undefined ? null : (
        <LED kind={stub ? "stub" : "testnet"} className="text-[24px] [&>span:first-child]:size-4" />
      )}
    </footer>
  );
}
