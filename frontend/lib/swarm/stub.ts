/**
 * The stand-in store (SWARM_MODE=stub, and always the default port under the test runner):
 * content-addressed JSON, ref = "swarm-stub:<sha256 of the JSON>". Kept in memory and, outside
 * tests, mirrored to data/swarm/<sha>.json so a restarted server can still serve it.
 *
 * The live port (./live.ts) reads these references too, for sieges that ended before the mode went
 * live; it never writes here.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SwarmPort, Transcript } from "@/lib/types";
import { REFERENCE_RE } from "./gateway";
import { recordSwarmRef } from "./refs";

const g = globalThis as unknown as { __swarmStub?: Map<string, Transcript> };
const store = (g.__swarmStub ??= new Map<string, Transcript>());
export const STUB_PREFIX = "swarm-stub:";

const dir = () => path.join(process.cwd(), "data", "swarm");
const persist = () => !process.env.VITEST;

/** Keep a transcript locally under its content hash; returns the stub reference. */
export function stubStore(transcript: Transcript): string {
  const json = JSON.stringify(transcript);
  const sha = createHash("sha256").update(json).digest("hex");
  const ref = STUB_PREFIX + sha;
  store.set(ref, transcript);
  if (persist()) {
    try {
      mkdirSync(dir(), { recursive: true });
      writeFileSync(path.join(dir(), `${sha}.json`), json);
    } catch {
      // memory copy is enough for the demo
    }
  }
  return ref;
}

export function stubRead(ref: string): Transcript | null {
  const hit = store.get(ref);
  if (hit) return hit;
  if (!ref.startsWith(STUB_PREFIX)) return null;
  const sha = ref.slice(STUB_PREFIX.length);
  if (!REFERENCE_RE.test(sha)) return null;
  try {
    const t = JSON.parse(readFileSync(path.join(dir(), `${sha}.json`), "utf8")) as Transcript;
    store.set(ref, t);
    return t;
  } catch {
    return null;
  }
}

export const swarmStub: SwarmPort = {
  async put(transcript: Transcript) {
    const ref = stubStore(transcript);
    try {
      recordSwarmRef(transcript.siegeId, ref);
    } catch {
      // the reference is a convenience for the Arkiv siege entity; never fail an upload over it
    }
    return { ref };
  },
  async get(ref: string) {
    return stubRead(ref);
  },
};
