/**
 * Display and sound preferences: skin, CRT overlay, mute, calm (forced reduced motion).
 *
 * Source of truth after load is the store below; it is seeded from `<html>` attributes, which the
 * inline bootstrap script in `app/layout.tsx` sets before first paint from `?skin=&crt=&calm=1`
 * or localStorage. Query params win for that page view and are not persisted (the wall and the
 * screenshot matrix use them); `setPref` persists to localStorage and writes the attribute.
 *
 * Framework-free so it can be unit-tested; React binding is `lib/hooks/usePrefs.ts`.
 */

export type Skin = "crt" | "neon";
export const SKINS: readonly Skin[] = ["crt", "neon"];

export type Prefs = {
  skin: Skin;
  /** CRT scanline overlay on. */
  crt: boolean;
  /** Sound muted (persisted under the sfx engine's key). */
  muted: boolean;
  /** Forced reduced motion (`?calm=1`), on top of the OS setting. */
  calm: boolean;
};
export type PrefKey = keyof Prefs;

/** What the server renders and what the first client render sees. */
export const DEFAULT_PREFS: Readonly<Prefs> = Object.freeze({ skin: "crt", crt: true, muted: false, calm: false });

export const PREF_STORAGE_KEYS: Readonly<Record<PrefKey, string>> = Object.freeze({
  skin: "siege.skin",
  crt: "siege.crt",
  muted: "siege.sfx.muted",
  calm: "siege.calm",
});

/** Query params the bootstrap script honours (not persisted). */
export const PREF_QUERY_KEYS = { skin: "skin", crt: "crt", calm: "calm" } as const;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

const ON = new Set(["1", "true", "on", "yes"]);
const OFF = new Set(["0", "false", "off", "no"]);

function bool(raw: string | null | undefined): boolean | undefined {
  if (raw == null) return undefined;
  const v = raw.trim().toLowerCase();
  if (ON.has(v)) return true;
  if (OFF.has(v)) return false;
  return undefined;
}

/** Parse one raw value (from storage, a query param or an attribute); undefined when invalid. */
export function parsePref<K extends PrefKey>(key: K, raw: string | null | undefined): Prefs[K] | undefined {
  if (key === "skin") {
    const v = raw?.trim().toLowerCase();
    return (v === "crt" || v === "neon" ? v : undefined) as Prefs[K] | undefined;
  }
  return bool(raw) as Prefs[K] | undefined;
}

/** Serialise for storage / attributes: skin as-is, crt "on"/"off", flags "1"/"0". */
export function serializePref<K extends PrefKey>(key: K, value: Prefs[K]): string {
  if (key === "skin") return String(value);
  if (key === "crt") return value ? "on" : "off";
  return value ? "1" : "0";
}

function safeGet(storage: StorageLike | null | undefined, k: string): string | null {
  try {
    return storage?.getItem(k) ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve prefs the same way the bootstrap script does: query param, then storage, then default.
 * `muted` has no query form.
 *
 * @example readPrefs(localStorage, location.search) // { skin: "neon", crt: false, muted: false, calm: false }
 */
export function readPrefs(storage: StorageLike | null | undefined, search = ""): Prefs {
  let q: URLSearchParams;
  try {
    q = new URLSearchParams(search);
  } catch {
    q = new URLSearchParams();
  }
  const pick = <K extends PrefKey>(k: K): Prefs[K] => {
    const fromQuery = k === "muted" ? undefined : parsePref(k, q.get(PREF_QUERY_KEYS[k as keyof typeof PREF_QUERY_KEYS]));
    return fromQuery ?? parsePref(k, safeGet(storage, PREF_STORAGE_KEYS[k])) ?? DEFAULT_PREFS[k];
  };
  return { skin: pick("skin"), crt: pick("crt"), muted: pick("muted"), calm: pick("calm") };
}

/** The `<html>` attributes for a prefs value (`data-calm` only when on). */
export function prefAttributes(p: Prefs): Record<"data-skin" | "data-crt" | "data-calm", string | null> {
  return { "data-skin": p.skin, "data-crt": p.crt ? "on" : "off", "data-calm": p.calm ? "1" : null };
}

/**
 * Inline script for `<head>`: applies data-skin / data-crt / data-calm before first paint.
 * Kept here so the store and the script agree on keys and parsing.
 */
export function bootstrapScript(): string {
  const k = PREF_STORAGE_KEYS;
  return `(function(){try{var d=document.documentElement,q=new URLSearchParams(location.search),s=null;function g(n){try{return localStorage.getItem(n)}catch(e){return null}}function b(v){if(v==null)return null;v=String(v).toLowerCase();if(v==="1"||v==="true"||v==="on"||v==="yes")return true;if(v==="0"||v==="false"||v==="off"||v==="no")return false;return null}var sk=(q.get("skin")||"").toLowerCase();if(sk!=="crt"&&sk!=="neon")sk=(g(${JSON.stringify(k.skin)})||"").toLowerCase();if(sk==="crt"||sk==="neon")d.setAttribute("data-skin",sk);var c=b(q.get("crt"));if(c===null)c=b(g(${JSON.stringify(k.crt)}));if(c!==null)d.setAttribute("data-crt",c?"on":"off");var m=b(q.get("calm"));if(m===null)m=b(g(${JSON.stringify(k.calm)}));if(m)d.setAttribute("data-calm","1");else d.removeAttribute("data-calm")}catch(e){}})()`;
}

// ─── store ────────────────────────────────────────────────────────────────────────────────

type Env = { storage: StorageLike | null; root: { setAttribute(n: string, v: string): void; removeAttribute(n: string): void; getAttribute(n: string): string | null } | null };

function browserEnv(): Env {
  if (typeof window === "undefined") return { storage: null, root: null };
  let storage: StorageLike | null = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null;
  }
  return { storage, root: document.documentElement };
}

let env: () => Env = browserEnv;
let state: Prefs | null = null;
const listeners = new Set<() => void>();
const sideEffects = new Set<(key: PrefKey, prefs: Prefs) => void>();

/** First read on the client: whatever the bootstrap script put on <html>, plus storage for the rest. */
function init(): Prefs {
  const { storage, root } = env();
  const stored = readPrefs(storage, "");
  if (!root) return stored;
  return {
    skin: parsePref("skin", root.getAttribute("data-skin")) ?? stored.skin,
    crt: parsePref("crt", root.getAttribute("data-crt")) ?? stored.crt,
    muted: stored.muted,
    calm: root.getAttribute("data-calm") === "1" ? true : stored.calm,
  };
}

export function getPrefs(): Prefs {
  if (!state) state = init();
  return state;
}

export function getServerPrefs(): Prefs {
  return DEFAULT_PREFS as Prefs;
}

export function subscribePrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Run `fn` after every change (the sfx bridge uses it to mirror `muted`). Returns an unsubscribe. */
export function onPrefChange(fn: (key: PrefKey, prefs: Prefs) => void): () => void {
  sideEffects.add(fn);
  return () => {
    sideEffects.delete(fn);
  };
}

/**
 * Change one pref: persists it, updates `<html>` and notifies subscribers.
 *
 * @example setPref("skin", "neon")
 */
export function setPref<K extends PrefKey>(key: K, value: Prefs[K]): void {
  const prev = getPrefs();
  if (prev[key] === value) return;
  const next = { ...prev, [key]: value };
  state = next;
  const { storage, root } = env();
  try {
    storage?.setItem(PREF_STORAGE_KEYS[key], serializePref(key, value));
  } catch {
    /* private mode: the change still applies for this page */
  }
  if (root && key !== "muted") {
    const attrs = prefAttributes(next);
    for (const [n, v] of Object.entries(attrs)) {
      if (v == null) root.removeAttribute(n);
      else root.setAttribute(n, v);
    }
  }
  for (const fn of sideEffects) {
    try {
      fn(key, next);
    } catch {
      /* a side effect must never break the toggle */
    }
  }
  for (const l of listeners) l();
}

/** Test hook: swap the environment and drop cached state. */
export function __resetPrefsForTest(nextEnv?: () => Env): void {
  env = nextEnv ?? browserEnv;
  state = null;
  listeners.clear();
  sideEffects.clear();
}
