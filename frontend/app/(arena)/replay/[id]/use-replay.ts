"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { api, type ReplayWithVerify } from "@/lib/api/client";

type ReplayState = { id: string; data?: ReplayWithVerify; error?: unknown };

/**
 * Still changing: an op in progress, ended but its money event has not landed yet, or one whose
 * recomputed evidence (lib/replay `verify.live`) is still waiting for its chain result.
 */
function stillMoving(r: ReplayWithVerify): boolean {
  if (r.verify?.live) return true;
  const s = r.siege;
  if (s.status === "created" || s.status === "in_progress") return true;
  if (s.settlement?.state === "failed" || s.settlement?.state === "void") return false;
  const money = s.status === "broken" ? "release" : "attempt";
  return !r.events.some((e) => e.type === money);
}

/**
 * GET /api/replay/[id] once. A live op (or one still settling) is re-read every 4 s until it is
 * final, so the tape grows and the end beat appears without a reload. Timers live in the effect.
 */
export function useReplay(id: string) {
  const [state, setState] = useState<ReplayState>({ id });
  const [nonce, setNonce] = useState(0);
  const current = state.id === id ? state : { id };

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      api.replay(id).then(
        (data) => {
          if (cancelled) return;
          setState({ id, data });
          if (stillMoving(data)) timer = setTimeout(load, 4000);
        },
        (error) => {
          if (cancelled) return;
          setState((prev) => (prev.id === id && prev.data ? { ...prev, error } : { id, error }));
        },
      );
    };
    load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [id, nonce]);

  return { data: current.data, error: current.error, retry: () => setNonce((n) => n + 1) };
}

// ─── owner flag (set by the pager page after a good owner key) ─────────────────────────────

const OWNER_FLAG = "siege.ownerAuthed";
const OWNER_EVT = "siege:owner-auth";

function subscribeOwner(cb: () => void) {
  window.addEventListener(OWNER_EVT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(OWNER_EVT, cb);
    window.removeEventListener("storage", cb);
  };
}

function readOwner(): boolean {
  try {
    return localStorage.getItem(OWNER_FLAG) === "1";
  } catch {
    return false;
  }
}

/** True on the owner's device. Hydration-safe (false on the server and the first client render). */
export function useOwnerFlag(): boolean {
  return useSyncExternalStore(subscribeOwner, readOwner, () => false);
}
