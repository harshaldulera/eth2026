import { randomUUID } from "node:crypto";

/** Short prefixed ids: castle_…, siege_…, agent_…, appr_…, rcpt_… */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export const nowIso = () => new Date().toISOString();

/** UTC calendar day, used for daily caps and the free daily siege. */
export const utcDay = (d: Date = new Date()) => d.toISOString().slice(0, 10);
