/**
 * This browser's free-recon identity: a random id made once and kept in localStorage. The server
 * keys the once-a-day free recon by it (POST /api/play/start `visitor`), so each phone that scans
 * the QR gets its own recon instead of sharing one for the whole arena.
 *
 * Call it from event handlers only (it touches storage); it never runs during render. Storage
 * blocked (private mode): a fresh id per page load, which still gives that visitor a recon.
 */

const KEY = "siege.visitor";
let memo: string | null = null;

function fresh(): string {
  const bytes = new Uint8Array(8);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 12);
}

export function visitorId(): string {
  if (memo) return memo;
  try {
    const v = localStorage.getItem(KEY);
    if (v && /^[a-z0-9]{6,32}$/.test(v)) return (memo = v);
    const id = fresh();
    localStorage.setItem(KEY, id);
    return (memo = id);
  } catch {
    return (memo = fresh());
  }
}
