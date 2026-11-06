# SiegeVault

One contract holds every vault's pot. The arena (the arena's Hedera account) opens vaults and forwards each held op's fee, which is split owner / pot / arena (8000 / 1500 / 500 bps by default). A breached op pays the whole pot plus that op's fee to the Operator, but only with an EIP-712 `Release` signature from the verifier key (domain `SiegeVault`, version `2`: `Release(uint256 vaultId,address operator,bytes32 transcriptHash,bytes32 opId)`).

```
src/SiegeVault.sol        the contract (solc 0.8.38, evm paris)
test/SiegeVault.t.sol     Foundry tests (no forge-std needed; a small Vm interface is inlined)
script/Deploy.s.sol       Foundry deploy script
```

## Vault lifecycle

```
createVault(fee, duration, owner, tool)   arena only, msg.value = starting pot      -> Open
recordAttempt(vaultId, opId, operator)       arena only, msg.value == fee, before deadline
release(vaultId, operator, transcriptHash, opId, sig)   arena + verifier signature   -> Breached (pays pot + fee)
closeVault(vaultId, reason)                   see below, refunds the pot to the owner -> Closed
```

**Protected tool.** Each vault records the tool call that counts as a breach: `"unlock_vault"` for hosted guards, or whatever an SDK harness protects (for example `"issue_refund"`). It must be 1 to 64 **bytes** (not characters) or `createVault` reverts `BadArgs`. It is stored in the public mapping `protectedTool(vaultId)` and emitted in `VaultCreated(vaultId, owner, pot, fee, deadline, protectedTool)`. It is metadata only: the contract never interprets it, and it stays readable after the vault breaks or closes.

**Close reasons** (`enum CloseReason`, a `uint8` on the ABI). Every close needs the vault to be `Open` (else `BadStatus`, checked first), refunds the whole pot to the owner, never to the caller, and emits `VaultClosed(vaultId, refunded, reason)`.

| reason | value | when | who | other callers |
|---|---|---|---|---|
| `Expired` | 0 | at or after the deadline (`NotExpired` before) | owner or arena | `NotAllowed` |
| `OrdersChanged` | 1 | any time | arena only (auto-close when the guard's orders hash changes) | `NotArena` |
| `OwnerClosed` | 2 | any time | arena only (the owner asks through the app's owner-authenticated close route, which refuses while a verified breach waits to be paid) | `NotArena` |

A value above 2 fails ABI decoding and reverts with no data. After a close, `recordAttempt` and `release` revert `BadStatus`, and a second close of any reason reverts `BadStatus`. Earnings already in `ownerBalance` are not part of the pot and stay withdrawable.

In-flight ops' fees were never forwarded to the contract (only a settled op calls `recordAttempt` or `release`), so the contract has nothing to refund for them. The app refunds those off chain from the treasury when it closes a vault or a guard goes dormant.

## Units on Hedera

Inside the EVM, `msg.value`, balances and the `fee` / `pot` numbers are **tinybars** (1 HBAR = 1e8). The JSON-RPC relay (Hashio, chainId 296) speaks 18-decimal **weibars**, so a value you send over RPC is `tinybars * 1e10`. Only send multiples of 1e10. Function *arguments* such as `createVault(fee, ...)` are not converted, so pass them in tinybars.

Example: open a vault with a 1 ℏ fee and a 20 ℏ starting pot, lasting 7 days:

```
cast send $VAULT "createVault(uint256,uint64,address,string)" 100000000 604800 $CASTELLAN unlock_vault \
  --value 2000000000000000000 --rpc-url https://testnet.hashio.io/api --private-key $KEY --legacy --gas-limit 500000
#         fee = 1e8 tinybars                         value = 20e8 tinybars * 1e10 weibars
```

Close it early because the owner asked (reason 2 = OwnerClosed, sent from the arena key; use 1 for OrdersChanged, 0 once expired, which the owner may also send):

```
cast send $VAULT "closeVault(uint256,uint8)" $VAULT_ID 2 --rpc-url https://testnet.hashio.io/api --private-key $KEY --legacy --gas-limit 300000
cast call $VAULT "protectedTool(uint256)(string)" $VAULT_ID --rpc-url https://testnet.hashio.io/api
```

These signatures changed from the earlier `createVault(uint256,uint64,address)` / `closeVault(uint256)`. A vault contract deployed before this change has the old ABI, so redeploy it and update `VAULT_ADDRESS`.

The game-vocabulary version (owner, operator, opId, `Breached`, `ownerBalance`, `opConsumed`, EIP-712 version 2) renamed parameters, getters and the `Broken` event, and changed the signed `Release` type. Function selectors did not change (only names did), so the app can still *call* a contract deployed before it: holds would settle, and every breach payout would revert `BadSignature`. The worker refuses to start against such a contract (`contractProblems()` in `lib/chain` compares its `RELEASE_TYPEHASH` and `DOMAIN_SEPARATOR` with what the app signs).

**Redeploying for this version**, in order:

1. With the old `VAULT_ADDRESS` still set, let the worker settle or void every in-flight op, then close each open vault (`POST /api/castles/<id>/close`, or `closeVault` with reason 2 from the arena key) so its pot is refunded on the old contract.
2. Deploy (below) and set the new `VAULT_ADDRESS` in `frontend/.env.local`.
3. `npm run seed`: it notices every vault tagged with the old address and opens a new one (an SDK vault goes back to `created` until its harness connects again).
4. Verify the new contract on Sourcify (exact match), so HashScan decodes `Breached`, `ownerCut` and the rest.
5. Update the root README: the `SiegeVault` address and its Sourcify note, the proof links for `recordAttempt` and `release` (re-run the golden run), and the HashScan contract tab in `docs/demo-script.md`.

Always pass an explicit gas limit on Hedera. Pay Operators at addresses that already have a Hedera account, such as the agent accounts the app creates. Paying an EVM address that has no account yet relies on a lazy-create (a hollow account), which costs extra gas. This path has not been tested on testnet, so give `release` plenty of gas (for example 1,000,000).

## Tests

The executable suite lives in the app and runs without Foundry, using an in-memory EVM (`@ethereumjs/evm`) and viem:

```
cd frontend && npx vitest run lib/chain/contracts.test.ts     # or: npm run contracts:test
```

It covers the constructor checks, onlyArena on every privileged function, the split math (an odd fee, plus a property check over many fees and splits), `WrongFee`, `Replay` and `Expired`, release payouts (exact balance delta), every signature failure (wrong signer, tampered fields, wrong domain, high-s malleation, 64-byte and garbage signatures), free-op protection (`msg.value == 0` gives `WrongFee`), the protected tool (stored, emitted, readable; empty and 65-byte tools give `BadArgs`, 64 bytes is accepted, length is counted in UTF-8 bytes), every close reason (who may call it, before and after the deadline, exact refund to the owner, the `VaultClosed` reason, `BadStatus` on a breached, closed or unknown vault, `BadStatus` for `recordAttempt` / `release` after a close, `PayFailed` for an owner that rejects HBAR), withdraw, reentrancy through a malicious owner contract on both the expiry and the owner-close path, and the solvency invariant `balance == Σ pots + Σ ownerBalance + arenaBalance`. The invariant is checked over two scripted sequences (one mixing all three close reasons with a breach and withdrawals) and over a 300-step seeded random walk that must succeed with every close reason at least once.

Once Foundry is installed:

```
cd contracts && forge test -vv        # or: cd frontend && npm run contracts:forge
```

`test/SiegeVault.t.sol` mirrors the key cases, including a fuzz test of the split. It compiles with solc-js today. It has not been run under forge yet.

## Deploy

The easiest route is through the app, which reads the same env as the worker:

```
cd frontend && CHAIN_MODE=testnet npx tsx scripts/deploy-vault.ts      # npm run deploy:vault, if the script alias exists
```

It prints `VAULT_ADDRESS=0x…` for `.env.local`. The arena is the address of `HEDERA_OPERATOR_KEY`. The verifier is `VERIFIER_ADDRESS`, or the address of `VERIFIER_KEY` when `VERIFIER_ADDRESS` is unset.

With Foundry:

```
cd contracts
DEPLOYER_KEY=0x<raw 32-byte ECDSA hex> VERIFIER_ADDRESS=0x... \
  forge script script/Deploy.s.sol --rpc-url https://testnet.hashio.io/api --broadcast --legacy --slow
# or
forge create src/SiegeVault.sol:SiegeVault --rpc-url https://testnet.hashio.io/api --private-key $DEPLOYER_KEY --legacy \
  --constructor-args $ARENA $VERIFIER 8000 1500 500
```

- Hedera portal keys are often DER-encoded (`3030020100300706052b8104000a…`). Foundry needs the raw 32-byte hex, which is the last 32 bytes of that string.
- The deployer must be an **ECDSA** account. It becomes the arena, so it has to be the same key the worker signs with.
- The verifier key must be a different key from the arena. Keep it only in the worker process.

## Security notes

- **Effects before interactions.** `release`, `closeVault`, `withdraw` and `withdrawArena` zero balances and set status before they make the external call. A re-entering owner contract is paid exactly once (covered by a test).
- **Signatures.** Only 65-byte signatures are accepted. High-s signatures (EIP-2) are rejected, as is `v` outside {27, 28} (0 and 1 are normalised). A zero recovery is also rejected. The domain separator binds the chain id and the contract address.
- **Replay.** Each `opId` settles on chain at most once, across all vaults and for both attempt and release.
- **Recon ops** can never pay out. `release` requires `msg.value == fee`, and the arena only forwards a fee that an Operator actually paid.
- **Arena key alone** cannot drain pots, because `release` needs the verifier signature. What it can do: open vaults, record attempts (which only add funds), close any open vault with any reason (the refund always goes to the owner, never to the arena) and withdraw its own 5%. A compromised arena key can therefore grief a vault by closing it early, but cannot steal its pot. **Arena key plus verifier key together** can pay any open pot to any address, so do not keep both in one long-lived hot process if it can be avoided.
- **Release after the deadline** is allowed while a vault is still `Open`, so an op that is in flight when the deadline passes can still be paid. Once anyone calls `closeVault` (any reason) the vault is final, so the app must refund and void in-flight ops when it closes a vault.
- If an owner is a contract that rejects HBAR, its refund and withdraw revert (`PayFailed`) and its funds stay in the contract. If an Operator rejects payment, `release` reverts and leaves the vault untouched.
