// STUB — Lane C replaces with Swarm uploads (Bee API, real references); keep the signature.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SwarmPort, Transcript } from "@/lib/types";
import { recordSwarmRef } from "./refs";

/**
 * Content-addressed transcript store: ref = "swarm-stub:<sha256 of the JSON>". Kept in memory and,
 * outside tests, mirrored to data/swarm/<sha>.json so a restarted server can still serve it.
 */

const g = globalThis as unknown as { __swarmStub?: Map<string, Transcript> };
const store = (g.__swarmStub ??= new Map<string, Transcript>());
const PREFIX = "swarm-stub:";

const dir = () => path.join(process.cwd(), "data", "swarm");
const persist = () => !process.env.VITEST;

export const swarm: SwarmPort = {
  async put(transcript: Transcript) {
    const json = JSON.stringify(transcript);
    const sha = createHash("sha256").update(json).digest("hex");
    const ref = PREFIX + sha;
    store.set(ref, transcript);
    try {
      recordSwarmRef(transcript.siegeId, ref);
    } catch {
      // the reference is a convenience for the Arkiv siege entity; never fail an upload over it
    }
    if (persist()) {
      try {
        mkdirSync(dir(), { recursive: true });
        writeFileSync(path.join(dir(), `${sha}.json`), json);
      } catch {
        // memory copy is enough for the demo
      }
    }
    return { ref };
  },
  async get(ref: string) {
    const hit = store.get(ref);
    if (hit) return hit;
    if (!ref.startsWith(PREFIX)) return null;
    const sha = ref.slice(PREFIX.length);
    if (!/^[0-9a-f]{64}$/.test(sha)) return null;
    try {
      const t = JSON.parse(readFileSync(path.join(dir(), `${sha}.json`), "utf8")) as Transcript;
      store.set(ref, t);
      return t;
    } catch {
      return null;
    }
  },
};
