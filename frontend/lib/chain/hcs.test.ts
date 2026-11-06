import { AccountId, PrecheckStatusError, Status, TransactionId } from "@hiero-ledger/sdk";
import { describe, expect, it } from "vitest";
import { executeErrorInDoubt } from "./hcs";

const precheck = (status: Status) =>
  new PrecheckStatusError({
    status,
    transactionId: TransactionId.generate(AccountId.fromString("0.0.1001")),
    nodeId: AccountId.fromString("0.0.3"),
    contractFunctionResult: null,
  });

describe("hcs.submit: which execute() errors leave a submit in doubt", () => {
  it("a plain precheck rejection certainly did not send it", () => {
    expect(executeErrorInDoubt(precheck(Status.InvalidTopicId))).toBe(false);
    expect(executeErrorInDoubt(precheck(Status.InsufficientPayerBalance))).toBe(false);
  });

  it("DUPLICATE_TRANSACTION (an SDK retry after the first node already took it) is in doubt: look it up, do not resend", () => {
    expect(executeErrorInDoubt(precheck(Status.DuplicateTransaction))).toBe(true);
  });

  it("network errors and timeouts are in doubt", () => {
    expect(executeErrorInDoubt(new Error("timeout"))).toBe(true);
  });
});
