import type { ReactNode } from "react";
import type { TxRef } from "@/lib/types";
import { accountUrl, contractUrl, isStubRef, topicUrl, txUrl } from "@/lib/chain/hashscan";
import { shortAccount, shortTx } from "@/lib/money/format";
import { cn } from "@/lib/utils";

export type HashscanLinkProps = {
  txId?: string;
  /** A TxRef from the API (uses its hashscanUrl and stub flag). */
  tx?: TxRef;
  accountId?: string;
  topicId?: string;
  /** EVM address or 0.0.x contract id. */
  contract?: string;
  /** Visible text; defaults to the shortened id. */
  label?: ReactNode;
  className?: string;
};

const STUB_TIP = "stub mode — switch CHAIN_MODE=testnet for real HashScan links";

/**
 * Link to HashScan (testnet), as a mono id with a pixel `↗`. Stub references render as a dashed
 * amber chip with a `STUB` tag so nobody mistakes a stub tx for a real one.
 *
 * @example <HashscanLink tx={siege.attempt} label="AttemptRecorded" />
 * @example <HashscanLink accountId="0.0.4512" />
 */
export function HashscanLink({ txId, tx, accountId, topicId, contract, label, className }: HashscanLinkProps) {
  let id: string | undefined;
  let url: string | undefined;
  let kind: "tx" | "account" | "topic" | "contract" = "tx";
  if (tx) {
    id = tx.txId;
    url = tx.hashscanUrl;
  } else if (txId) {
    id = txId;
    url = txUrl(txId);
  } else if (accountId) {
    id = accountId;
    url = accountUrl(accountId);
    kind = "account";
  } else if (topicId) {
    id = topicId;
    url = topicUrl(topicId);
    kind = "topic";
  } else if (contract) {
    id = contract;
    url = contractUrl(contract);
    kind = "contract";
  }
  if (!id) return null;

  const stub = (tx?.stub ?? false) || isStubRef(id) || !url || url.startsWith("#");
  const short = kind === "tx" ? shortTx(id) : shortAccount(id);

  if (stub) {
    return (
      <span
        tabIndex={0}
        title={STUB_TIP}
        aria-label={`${kind === "tx" ? "stub tx" : `stub ${kind}`} ${id}. ${STUB_TIP}`}
        className={cn(
          "group/stub relative inline-flex max-w-full items-center gap-1.5 border border-dashed border-money/50 bg-money/[0.06] py-0.5 pr-1.5 pl-0.5 align-middle font-mono text-[11px] leading-4 text-ink-dim",
          className,
        )}
      >
        <span className="bg-money/80 px-1 font-ui text-[9px] leading-[14px] tracking-[0.12em] text-bg uppercase">
          stub {kind === "tx" ? "tx" : kind}
        </span>
        <span className="truncate">{label ?? short}</span>
        <span
          role="tooltip"
          className="pointer-events-none absolute bottom-full left-0 z-30 mb-1.5 hidden w-60 bg-raised px-2.5 py-1.5 font-sans text-[11px] leading-snug text-ink px-frame group-hover/stub:block group-focus/stub:block"
        >
          {STUB_TIP}
        </span>
      </span>
    );
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      title={`Open ${id} on HashScan`}
      className={cn(
        "inline-flex max-w-full items-center gap-1 align-middle font-mono text-[12px] text-ink underline decoration-line decoration-2 underline-offset-4 transition-colors hover:text-money hover:decoration-money/70 focus-visible:text-money",
        className,
      )}
    >
      <span className="truncate">{label ?? short}</span>
      <span aria-hidden className="shrink-0 font-ui text-[11px] text-money">
        ↗
      </span>
    </a>
  );
}
