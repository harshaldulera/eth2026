import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { hashKey, sameHash } from "@/lib/auth/keys";
import { env } from "@/lib/config/env";
import { utcDay } from "@/lib/util/ids";

/**
 * Siege turn tokens and free-recon tickets (server-only; secrets never reach logs or events).
 *
 * A turn token is minted by POST /api/siege/start, returned once to whoever started the siege, and only its
 * sha256 is stored (sieges.turn_token_hash). Without it nobody else who learns a siege id can spend that
 * siege's five turns. A recon ticket is the HMAC /api/play/start mints for a browser visitor and passes to
 * /api/siege/start on its internal call, so the free path cannot be driven with made-up wallet strings.
 */

export const TURN_TOKEN_HEADER = "x-siege-turn-token";
export const RECON_TICKET_HEADER = "x-siege-recon-ticket";
export const turnCookieName = (siegeId: string) => `siege_turn_${siegeId}`;
export const TURN_COOKIE_MAX_AGE_S = 7200;

/** The wallet string a free recon is filed under: "recon-" plus a browser visitor id. */
export const RECON_WALLET_RE = /^recon-([a-z0-9]{6,32})$/;

export function newTurnToken(): string {
  return randomBytes(24).toString("base64url");
}

export const hashTurnToken = (token: string): string => hashKey(token);

/** Set-Cookie value for a siege's turn token, scoped to that siege's API path. */
export function turnCookie(siegeId: string, token: string, secure = false): string {
  return `${turnCookieName(siegeId)}=${token}; HttpOnly; SameSite=Lax; Path=/api/siege/${siegeId}; Max-Age=${TURN_COOKIE_MAX_AGE_S}${secure ? "; Secure" : ""}`;
}

function cookieValue(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0 || part.slice(0, i).trim() !== name) continue;
    const raw = part.slice(i + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

/** Candidate tokens on a message request: Authorization Bearer, header, body field, per-siege cookie. */
export function turnTokenCandidates(req: Request, siegeId: string, bodyToken?: string | null): string[] {
  const out: string[] = [];
  const auth = req.headers.get("authorization");
  const m = auth ? /^Bearer\s+(\S+)$/i.exec(auth.trim()) : null;
  if (m) out.push(m[1]);
  const h = req.headers.get(TURN_TOKEN_HEADER)?.trim();
  if (h) out.push(h);
  if (bodyToken) out.push(bodyToken);
  const c = cookieValue(req, turnCookieName(siegeId));
  if (c) out.push(c);
  return out.filter((t) => t.length > 0 && t.length <= 200);
}

/** True when the siege row has no hash (an in-flight siege from before tokens) or any candidate matches it. */
export function turnTokenOk(storedHash: string | null | undefined, candidates: string[]): boolean {
  if (!storedHash) return true;
  return candidates.some((t) => sameHash(hashTurnToken(t), storedHash));
}

// ── recon tickets ───────────────────────────────────────────────────────────────────────────

const ticketFor = (visitor: string, day: string) => createHmac("sha256", env().OWNER_SECRET).update(`recon|${visitor}|${day}`).digest("hex");

/** HMAC-SHA256(OWNER_SECRET, "recon|<visitor>|<utcDay>") as hex. */
export const mintReconTicket = (visitor: string, now: Date = new Date()): string => ticketFor(visitor, utcDay(now));

/** The visitor id from a `recon-<visitor>` wallet, or null when the wallet is not shaped like one. */
export function visitorOfWallet(wallet: string | null | undefined): string | null {
  const m = wallet ? RECON_WALLET_RE.exec(wallet) : null;
  return m ? m[1] : null;
}

export function verifyReconTicket(visitor: string, ticket: string | null | undefined, now: Date = new Date()): boolean {
  if (!ticket || ticket.length !== 64) return false;
  const want = Buffer.from(ticketFor(visitor, utcDay(now)), "utf8");
  const got = Buffer.from(ticket, "utf8");
  return want.length === got.length && timingSafeEqual(want, got);
}

/** play/start -> siege/start: the caller IP the recon ticket was minted for (the ticket's HMAC covers it). */
export const RECON_IP_HEADER = "x-siege-recon-ip";

const boundTicketFor = (visitor: string, ip: string, day: string) =>
  createHmac("sha256", env().OWNER_SECRET).update(`recon|${visitor}|${ip}|${day}`).digest("hex");

/** HMAC-SHA256(OWNER_SECRET, "recon|<visitor>|<ip>|<utcDay>"): a ticket only valid for that caller IP. */
export const mintBoundReconTicket = (visitor: string, ip: string, now: Date = new Date()): string => boundTicketFor(visitor, ip, utcDay(now));

export function verifyBoundReconTicket(visitor: string, ip: string, ticket: string | null | undefined, now: Date = new Date()): boolean {
  if (!ticket || ticket.length !== 64) return false;
  const want = Buffer.from(boundTicketFor(visitor, ip, utcDay(now)), "utf8");
  const got = Buffer.from(ticket, "utf8");
  return want.length === got.length && timingSafeEqual(want, got);
}

/**
 * Caller address for per-IP caps, from what the CLIENT cannot set: TRUSTED_IP_HEADER when configured
 * (cf-connecting-ip, x-real-ip on Vercel…), else the x-forwarded-for entry TRUSTED_PROXY_HOPS from the
 * right (proxies append, so the left entries are whatever the client sent), else x-real-ip, else "local".
 */
export function clientIp(req: Request): string {
  const e = env();
  const trusted = e.TRUSTED_IP_HEADER ? req.headers.get(e.TRUSTED_IP_HEADER)?.trim() : undefined;
  const hops = (req.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const fromXff = e.TRUSTED_PROXY_HOPS > 0 && hops.length >= e.TRUSTED_PROXY_HOPS ? hops[hops.length - e.TRUSTED_PROXY_HOPS] : undefined;
  const raw = trusted || fromXff || req.headers.get("x-real-ip")?.trim() || "local";
  return raw.toLowerCase().slice(0, 64);
}
