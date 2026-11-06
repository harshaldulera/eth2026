import { env } from "@/lib/config/env";

/**
 * How the worker reaches the HTTP API. Default: real fetch against APP_URL (the Next server).
 * scripts/demo.ts injects an in-process dispatcher (worker/dispatch.ts) so no server is needed;
 * the same override is read by app/api/_lib/http.ts internalFetch() for /api/play/start.
 */

const g = globalThis as unknown as { __siegeInternalFetch?: typeof fetch };

export function setFetch(f: typeof fetch | null): void {
  g.__siegeInternalFetch = f ?? undefined;
}

export function getFetch(): typeof fetch {
  return g.__siegeInternalFetch ?? fetch;
}

export function apiUrl(path: string): string {
  return new URL(path, env().APP_URL).toString();
}
