"use client";

import { useEffect, useSyncExternalStore } from "react";
import { api, type ConfigResponse } from "@/lib/api/client";

type ConfigState = { config: ConfigResponse | null; error: unknown };

const SERVER_STATE: ConfigState = { config: null, error: undefined };
let state: ConfigState = SERVER_STATE;
let inflight: Promise<void> | null = null;
let retry: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function set(next: ConfigState) {
  state = next;
  for (const l of listeners) l();
}

/** Fetch once per page load; on error, retry every 5s while anyone is subscribed. */
function load() {
  if (state.config || inflight) return;
  inflight = api
    .config()
    .then(
      (config) => set({ config, error: undefined }),
      (error) => {
        set({ config: null, error });
        clearTimeout(retry);
        retry = setTimeout(() => listeners.size && load(), 5000);
      },
    )
    .finally(() => {
      inflight = null;
    });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * GET /api/config, fetched once per page load and shared by every caller (retries every 5s on error).
 *
 * Hydration-safe: the first client render always sees `config: null`, the same as the server,
 * even when another component already loaded the config (useSyncExternalStore's server snapshot).
 *
 * @example const { config } = useConfig(); const stub = config?.chain.mode !== "testnet";
 */
export function useConfig(): ConfigState {
  const snapshot = useSyncExternalStore(subscribe, () => state, () => SERVER_STATE);
  useEffect(load, []);
  return snapshot;
}
