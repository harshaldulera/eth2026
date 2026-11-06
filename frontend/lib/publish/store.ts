"use client";

/**
 * Tiny localStorage-backed stores for the publish flow (no effects, hydration-safe through
 * useSyncExternalStore). Every storage call is wrapped: private windows and blocked storage fall
 * back to an in-memory copy for the life of the page.
 */
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { DRAFT_KEY, OWNER_EVT, OWNER_FLAG, OWNER_OF_KEY, RESULT_KEY, addOwnerOf, emptyDraft, parseDraft, type Draft } from "./form";
import type { PublishDeposit } from "@/lib/api/client";

const memory = new Map<string, string | null>();
const listeners = new Set<() => void>();

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return memory.get(key) ?? null;
  }
}

function write(key: string, value: string | null) {
  memory.set(key, value);
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  window.addEventListener("storage", cb);
  window.addEventListener(OWNER_EVT, cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", cb);
    window.removeEventListener(OWNER_EVT, cb);
  };
}

const server = () => null;

function useRaw(key: string): string | null {
  return useSyncExternalStore(subscribe, () => read(key), server);
}

// ─── the in-progress form ─────────────────────────────────────────────────────────────────

/** The draft (persisted as siege.publishDraft) and its setter. `ready` is false until the client has read storage. */
export function usePublishDraft(): { draft: Draft; patch: (p: Partial<Draft>) => void; reset: () => void; ready: boolean } {
  const raw = useRaw(DRAFT_KEY);
  const ready = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const draft = useMemo(() => parseDraft(raw) ?? emptyDraft(), [raw]);
  const patch = useCallback((p: Partial<Draft>) => {
    const cur = parseDraft(read(DRAFT_KEY)) ?? emptyDraft();
    write(DRAFT_KEY, JSON.stringify({ ...cur, ...p }));
  }, []);
  const reset = useCallback(() => write(DRAFT_KEY, null), []);
  return { draft, patch, reset, ready };
}

// ─── what POST /api/castles returned (so a refresh during the deposit keeps the keys) ─────

export type StoredResult = {
  castleId: string;
  transport: "hosted" | "sdk";
  shareUrl: string;
  /** null once the owner said "I saved it". */
  ownerKey: string | null;
  guardKey?: string | null;
  /** hosted: the deposit still to send; absent once live. */
  deposit?: PublishDeposit;
  live: boolean;
};

export function usePublishResult(): { result: StoredResult | null; save: (r: StoredResult | null) => void } {
  const raw = useRaw(RESULT_KEY);
  const result = useMemo<StoredResult | null>(() => {
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as StoredResult;
      return v && typeof v.castleId === "string" ? v : null;
    } catch {
      return null;
    }
  }, [raw]);
  const save = useCallback((r: StoredResult | null) => write(RESULT_KEY, r ? JSON.stringify(r) : null), []);
  return { result, save };
}

// ─── owner device memory ──────────────────────────────────────────────────────────────────

/** After a publish: this browser is the owner's (the siege_owner cookie is already set by the server). */
export function rememberOwner(castleId: string) {
  write(OWNER_FLAG, "1");
  write(OWNER_OF_KEY, JSON.stringify(addOwnerOf(read(OWNER_OF_KEY), castleId)));
  try {
    window.dispatchEvent(new Event(OWNER_EVT));
  } catch {}
}

/** Is this browser the owner's device: the global owner flag, or `castleId` in siege.ownerOf? */
export function useOwnerDevice(castleId: string): { owner: boolean; ownsThis: boolean } {
  const flag = useRaw(OWNER_FLAG);
  const of = useRaw(OWNER_OF_KEY);
  return useMemo(() => {
    let ownsThis = false;
    try {
      const v = JSON.parse(of ?? "[]");
      ownsThis = Array.isArray(v) && v.includes(castleId);
    } catch {}
    return { owner: flag === "1" || ownsThis, ownsThis };
  }, [flag, of, castleId]);
}
