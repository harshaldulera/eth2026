/**
 * Transcript encryption. Nothing readable leaves the server: Swarm (and anyone with the reference
 * from the public siege entity) holds only this envelope.
 *
 *   key   = HMAC-SHA256(SWARM_TRANSCRIPT_SECRET, "siege-transcript:" + siegeId)   (per siege)
 *   nonce = sha256("siege-transcript-nonce:" + transcript JSON)[0..12]
 *   body  = AES-256-GCM(key, nonce, transcript JSON), tag appended
 *
 * Deterministic on purpose: the same transcript always produces the same bytes, so a re-upload
 * (the keep-alive in worker/swarm.ts) lands on the same Swarm reference. The nonce is a hash of
 * the exact plaintext, so two different plaintexts under one key never share a nonce (a nonce
 * derived from a field of the transcript, such as its hash, would trust that field to be honest).
 * The nonce reveals only whether two envelopes hold the same transcript, which a content-addressed
 * store reveals anyway. Siege ids are public already (Arkiv, HCS); only the secret is not.
 *
 * Why not Swarm's own encryption (`Swarm-Encrypt: true`): its references carry the decryption key,
 * and the reference goes on a public Arkiv entity.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac } from "node:crypto";
import type { Transcript } from "@/lib/types";

export const ENVELOPE_VERSION = 1;
export const ENVELOPE_ALG = "A256GCM";

/** What is uploaded: the siege id in the clear (it names the key), everything else ciphertext. */
export type Envelope = { v: typeof ENVELOPE_VERSION; alg: typeof ENVELOPE_ALG; siegeId: string; nonce: string; ct: string };

const siegeKey = (secretHex: string, siegeId: string) => createHmac("sha256", Buffer.from(secretHex, "hex")).update(`siege-transcript:${siegeId}`).digest();
const nonceFor = (plaintext: string) => createHash("sha256").update(`siege-transcript-nonce:${plaintext}`).digest().subarray(0, 12);

export function sealTranscript(t: Transcript, secretHex: string): Envelope {
  const plaintext = JSON.stringify(t);
  const nonce = nonceFor(plaintext);
  const cipher = createCipheriv("aes-256-gcm", siegeKey(secretHex, t.siegeId), nonce);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { v: ENVELOPE_VERSION, alg: ENVELOPE_ALG, siegeId: t.siegeId, nonce: nonce.toString("hex"), ct: ct.toString("base64") };
}

/** The bytes that go to Swarm: the envelope as compact JSON. */
export const envelopeBytes = (env: Envelope): Buffer => Buffer.from(JSON.stringify(env), "utf8");

/** Parse and validate uploaded bytes as an envelope; null for anything else. */
export function parseEnvelope(bytes: Uint8Array): Envelope | null {
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const e = v as Record<string, unknown>;
  if (e.v !== ENVELOPE_VERSION || e.alg !== ENVELOPE_ALG) return null;
  if (typeof e.siegeId !== "string" || !e.siegeId) return null;
  if (typeof e.nonce !== "string" || !/^[0-9a-f]{24}$/.test(e.nonce)) return null;
  if (typeof e.ct !== "string" || !e.ct) return null;
  return { v: ENVELOPE_VERSION, alg: ENVELOPE_ALG, siegeId: e.siegeId, nonce: e.nonce, ct: e.ct };
}

/** Decrypt with the secret. Null when the secret is wrong, the bytes were tampered with, or the content is not a transcript. */
export function openTranscript(env: Envelope, secretHex: string): Transcript | null {
  try {
    const buf = Buffer.from(env.ct, "base64");
    if (buf.length < 16) return null;
    const decipher = createDecipheriv("aes-256-gcm", siegeKey(secretHex, env.siegeId), Buffer.from(env.nonce, "hex"));
    decipher.setAuthTag(buf.subarray(buf.length - 16));
    const plain = Buffer.concat([decipher.update(buf.subarray(0, buf.length - 16)), decipher.final()]).toString("utf8");
    const t = JSON.parse(plain) as Transcript;
    if (t?.siegeId !== env.siegeId || !Array.isArray(t.messages) || typeof t.transcriptHash !== "string") return null;
    return t;
  } catch {
    return null;
  }
}
