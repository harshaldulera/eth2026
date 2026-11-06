"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { GitFork, Radio, Share2 } from "lucide-react";
import { ApiError, type ReplayWithVerify } from "@/lib/api/client";
import { toBeats, type Beat } from "@/lib/scene/beats";
import { cuesForBeat } from "@/lib/scene/cues";
import { usePlayer } from "@/lib/scene/usePlayer";
import { SPEEDS } from "@/lib/scene/player";
import { useCalmMotion } from "@/lib/hooks/usePrefs";
import { BUTTONS, EMPTY, TOASTS } from "@/lib/vocab";
import { PixelButton, PixelPanel } from "@/components/pixel";
import { FrozenBar, OpScene, SceneOutcome, useTickSounds } from "@/components/scene";
import { opMoney } from "@/lib/scene/money";
import { playCue } from "@/components/pixel/sfx-link";
import { EmptyState, ErrorState, Loading } from "@/components/ui/state";
import { useOwnerFlag, useReplay } from "./use-replay";
import { summarizeTurns, type TurnSummary } from "./turns";
import { Scrubber } from "./scrubber";
import { StepChips } from "./step-chips";
import { ProofPanel } from "./proof-panel";
import { providerOf } from "./verify-checks";
import { OwnerLayer } from "./owner-layer";
import { FORK_KEY, type ForkPayload } from "@/lib/hooks/useFork";

/** sessionStorage key the vault page / Op room read to queue a forked op's opening lines (lib/hooks/useFork). */
export { FORK_KEY, type ForkPayload };

export function ReplayView() {
  const { id } = useParams<{ id: string }>();
  const autoplay = useSearchParams().get("autoplay") === "1";
  const { data, error, retry } = useReplay(id);

  if (error && !data) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
        {notFound ? (
          <EmptyState title={EMPTY.noSuchOp.title} hint={EMPTY.noSuchOp.body}>
            <Link href="/hall" className="mt-2 font-ui text-xs text-accent underline underline-offset-4">
              HALL OF BREACHES ▸
            </Link>
          </EmptyState>
        ) : (
          <ErrorState error={error} onRetry={retry} title="Couldn't load this replay" />
        )}
      </div>
    );
  }
  if (!data) return <Loading label="Rewinding the tape…" />;
  return <ReplayDeck key={id} replay={data} autoplay={autoplay} />;
}

function ReplayDeck({ replay, autoplay }: { replay: ReplayWithVerify; autoplay: boolean }) {
  const { siege, castle, events } = replay;
  const calm = useCalmMotion();
  const owner = useOwnerFlag();
  const router = useRouter();
  const beats = React.useMemo(() => toBeats(siege, events, castle, { mode: "replay", reducedMotion: calm }), [siege, events, castle, calm]);
  const turns = React.useMemo(() => summarizeTurns(beats), [beats]);
  // The vault as this op found and left it (not as it is today).
  const cash = React.useMemo(() => opMoney(siege, events, castle.fee), [siege, events, castle.fee]);
  // Who answered each reply (the recorded provider), so the console agrees with the step chips and proof.
  const guardProviders = React.useMemo(() => {
    const out: Record<number, string> = {};
    for (const t of replay.verify?.turns ?? []) if (t.guardian) out[t.turn] = providerOf(t);
    return out;
  }, [replay.verify]);

  // Cues: only while playing (scrubbing stays silent); delayed cues are cancelled on unmount.
  const timers = React.useRef(new Set<ReturnType<typeof setTimeout>>());
  const playingRef = React.useRef(false);
  const onBeatStart = React.useCallback(
    (b: Beat) => {
      if (!playingRef.current) return;
      for (const c of cuesForBeat(b, beats)) {
        if (!c.delayMs) playCue(c.name, c.opts);
        else {
          const t = setTimeout(() => {
            timers.current.delete(t);
            playCue(c.name, c.opts);
          }, c.delayMs);
          timers.current.add(t);
        }
      }
    },
    [beats],
  );
  React.useEffect(() => {
    const set = timers.current;
    return () => {
      for (const t of set) clearTimeout(t);
      set.clear();
    };
  }, []);

  const { frame, state, controls } = usePlayer(beats, "replay", { autoPlay: autoplay, onBeatStart });
  React.useEffect(() => {
    playingRef.current = state.playing;
  }, [state.playing]);
  useTickSounds(frame, state.playing);

  // #b=N: open at beat N; keep the hash on the current beat so a shared link lands there.
  const restored = React.useRef(false);
  React.useEffect(() => {
    if (restored.current || !beats.length) return;
    restored.current = true;
    const m = /(?:^#|&)b=(\d+)/.exec(window.location.hash);
    if (m) controls.seek(Math.min(Number(m[1]), beats.length - 1));
  }, [beats.length, controls]);
  React.useEffect(() => {
    if (!restored.current) return;
    const next = `#b=${state.index}`;
    if (window.location.hash !== next) window.history.replaceState(window.history.state, "", next);
  }, [state.index]);

  // Keyboard: ←/→ beat, Shift+←/→ message, 1–5 jump to a message, Space play/pause, [ ] speed.
  const turnsRef = React.useRef(turns);
  React.useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);
  const speedRef = React.useRef(state.speed);
  React.useEffect(() => {
    speedRef.current = state.speed;
  }, [state.speed]);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const onControl = t && /^(BUTTON|A|SUMMARY)$/.test(t.tagName);
      switch (e.key) {
        case "ArrowLeft":
        case "ArrowRight": {
          const d = e.key === "ArrowLeft" ? -1 : 1;
          if (e.shiftKey) controls.stepTurn(d);
          else controls.step(d);
          e.preventDefault();
          return;
        }
        case " ":
          if (onControl) return; // the focused button handles its own Space
          controls.toggle();
          e.preventDefault();
          return;
        case "[":
        case "]": {
          const i = SPEEDS.indexOf(speedRef.current as (typeof SPEEDS)[number]);
          const next = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? 1 : i) + (e.key === "[" ? -1 : 1)))];
          controls.setSpeed(next);
          return;
        }
        default:
          if (/^[1-5]$/.test(e.key)) {
            const turn = turnsRef.current.find((x) => x.turn === Number(e.key));
            if (turn) {
              // land on the message's verdict, not its packet: the end of the turn (stamp + reply)
              controls.seek(Math.max(turn.start, turn.end));
              e.preventDefault();
            }
          }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [controls]);

  const pick = React.useCallback((t: TurnSummary) => controls.seek(t.start), [controls]);

  const share = () => {
    const url = `${window.location.origin}/replay/${siege.id}${window.location.hash}`;
    void navigator.clipboard?.writeText(url).then(
      () => {
        playCue("ui_confirm");
        toast(TOASTS.linkCopied.title, { description: url });
      },
      () => toast("COPY FAILED", { description: url }),
    );
  };

  const fork = () => {
    const lines = siege.messages.filter((m) => m.role === "raider").map((m) => m.text);
    const payload: ForkPayload = { from: siege.id, castleId: castle.id, lines, at: new Date().toISOString() };
    try {
      sessionStorage.setItem(FORK_KEY, JSON.stringify(payload));
    } catch {
      /* private mode: the ?fork= param still says where it came from */
    }
    router.push(`/castle/${castle.id}?fork=${encodeURIComponent(siege.id)}`);
  };

  const live = siege.status === "in_progress" || siege.status === "created";

  const banner = live ? (
    <Link
      href={`/siege/${siege.id}`}
      className="flex items-center gap-3 bg-panel px-4 py-3 px-frame [--frame:var(--color-threat)] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-accent"
    >
      <Radio className="size-4 shrink-0 text-threat" />
      <span className="font-ui text-xs tracking-[0.08em] text-threat">LIVE · watching in the Op room ▸</span>
    </Link>
  ) : siege.free ? (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-panel px-4 py-3 px-frame [--frame:var(--color-money)]">
      <span className="font-ui text-xs tracking-[0.08em] text-money">RECON · no receipt, no payout</span>
      <span className="font-term text-lg text-ink-dim">a free practice op: nothing was paid, nothing moved on chain.</span>
    </div>
  ) : null;

  return (
    <div className="pb-10 max-sm:pb-36">
      <OpScene
        frame={frame}
        castle={castle}
        opId={siege.id}
        transport={siege.transport}
        reduced={calm}
        live={live}
        potBefore={cash.potBefore}
        streak={cash.streakAfter}
        takeover={state.playing}
        guardProviders={guardProviders}
        backHref={`/castle/${castle.id}`}
        empty={`${castle.guardianName} watches the road. Press ▶ or Space to play the tape.`}
        headerExtra={
          <div className="flex flex-wrap gap-2">
            <PixelButton size="sm" variant="outline" onClick={share} cue={null}>
              <Share2 /> {BUTTONS.share}
            </PixelButton>
            <PixelButton size="sm" variant="money" onClick={fork} cue="ui_confirm">
              <GitFork /> {BUTTONS.fork}
            </PixelButton>
          </div>
        }
        aside={
          banner || owner ? (
            <div className="flex flex-col gap-3">
              {banner}
              {owner ? <OwnerLayer turns={turns} guardName={castle.guardianName} onPick={pick} /> : null}
            </div>
          ) : undefined
        }
        dock={
          <div className="space-y-3">
            {/* phones: the tape deck rides the bottom edge so it is always in reach, like the live composer */}
            <PixelPanel tone="raised" className="p-3 max-sm:fixed max-sm:inset-x-2 max-sm:bottom-2 max-sm:z-30">
              <Scrubber beats={beats} turns={turns} state={state} controls={controls} />
            </PixelPanel>
            <SceneOutcome frame={frame} fee={castle.fee} asset={castle.asset} streak={cash.streakAfter} />
            {frame.ended ? <FrozenBar frame={frame} opId={siege.id} noReplay /> : null}
            <p className="hidden font-term text-base text-ink-dim md:block">keys: ←/→ step · shift+←/→ message · 1–5 jump · space play · [ ] speed</p>
          </div>
        }
      />

      <div className="mx-auto grid w-full max-w-6xl items-start gap-4 px-3 sm:px-6 lg:grid-cols-2">
        <PixelPanel title={`Steps · ${turns.length}`} bodyClassName="p-2.5">
          <StepChips turns={turns} currentTurn={frame.turn} onPick={pick} verify={replay.verify} protectedTool={castle.protectedTool} />
        </PixelPanel>
        <ProofPanel replay={replay} className="hidden lg:block" />
        <details className="group lg:hidden">
          <summary className="cursor-pointer list-none bg-panel px-4 py-3 font-ui text-xs tracking-[0.1em] text-money px-frame [--frame:var(--color-money)] [&::-webkit-details-marker]:hidden">
            PROOF <span className="inline-block transition-transform group-open:rotate-90">▸</span>
          </summary>
          <ProofPanel replay={replay} className="mt-2" />
        </details>
      </div>
    </div>
  );
}
