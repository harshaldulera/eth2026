import type { Amount, Siege, SiegeEvent, StoredSiegeEvent } from "@/lib/types";
import { lastOf, parseAttempt, parseRelease } from "@/lib/money/events";
import { toUnits } from "@/lib/money/format";

/**
 * The vault's money as it was during one op, read off that op's own events (pure). A replay or a
 * revisited op room must not show today's pot and streak: the vault has moved on since.
 *
 * - paid held / lockdown: the attempt event carries the split and the new pot, so the pot before
 *   the op is `newPot − split.pot`, and the streak after it is the event's `streak`.
 * - paid breach: the release pays out pot + fee, so the pot before is `amount − fee`.
 * - free ops (recon) never move the pot, and anything still running has no settle event yet:
 *   `potBefore` is undefined there and the caller keeps its own snapshot.
 */
export type OpMoney = { potBefore?: Amount; potAfter?: Amount; streakAfter?: number };

type MoneySiege = Pick<Siege, "id" | "status"> & Partial<Pick<Siege, "free" | "receipt">>;

export function opMoney(siege: MoneySiege, events: readonly (SiegeEvent | StoredSiegeEvent)[], fee?: Amount): OpMoney {
  const evs = events.filter((e) => !e.siegeId || e.siegeId === siege.id) as SiegeEvent[];
  const out: OpMoney = {};
  const aEv = lastOf(evs, "attempt");
  if (aEv) {
    const a = parseAttempt(aEv.payload);
    if (a.streak !== undefined) out.streakAfter = a.streak;
    if (aEv.payload.free !== true && a.newPot && a.split) {
      const before = toUnits(a.newPot) - toUnits(a.split.pot);
      if (before >= BigInt(0)) {
        out.potBefore = before.toString();
        out.potAfter = a.newPot;
      }
    }
  }
  const rEv = lastOf(evs, "release");
  if (rEv && rEv.payload.free !== true && !siege.free) {
    const r = parseRelease(rEv.payload);
    const paidFee = siege.receipt && !siege.receipt.free ? siege.receipt.amount : fee;
    if (r.amount && paidFee) {
      const before = toUnits(r.amount) - toUnits(paidFee);
      if (before >= BigInt(0)) {
        out.potBefore = before.toString();
        out.potAfter = "0";
      }
    }
  }
  return out;
}
