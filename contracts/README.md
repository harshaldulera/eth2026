# SiegeVault

One contract holds every castle's pot. The arena (the operator account) opens vaults and forwards each held siege's fee, which is split castellan / pot / arena (8000 / 1500 / 500 bps by default). A broken siege pays the whole pot plus that siege's fee to the Raider, but only with an EIP-712 `Release` signature from the verifier key.

```
src/SiegeVault.sol        the contract (solc 0.8.38, evm paris)
test/SiegeVault.t.sol     Foundry tests (no forge-std needed; a small Vm interface is inlined)
script/Deploy.s.sol       Foundry deploy script
```

## Units on Hedera

Inside the EVM, `msg.value`, balances and the `fee` / `pot` numbers are **tinybars** (1 HBAR = 1e8). The JSON-RPC relay (Hashio, chainId 296) speaks 18-decimal **weibars**, so a value you send over RPC is `tinybars * 1e10`. Only send multiples of 1e10. Function *arguments* such as `createVault(fee, ...)` are not converted, so pass them in tinybars.

Example: open a vault with a 1 ℏ fee and a 20 ℏ starting pot, lasting 7 days:

```
cast send $VAULT "createVault(uint256,uint64,address)" 100000000 604800 $CASTELLAN \
  --value 2000000000000000000 --rpc-url https://testnet.hashio.io/api --private-key $KEY --legacy --gas-limit 400000
#         fee = 1e8 tinybars                         value = 20e8 tinybars * 1e10 weibars
```

Always pass an explicit gas limit on Hedera. Pay Raiders at addresses that already have a Hedera account, such as the agent accounts the app creates. Paying an EVM address that has no account yet relies on a lazy-create (a hollow account), which costs extra gas. This path has not been tested on testnet, so give `release` plenty of gas (for example 1,000,000).

## Tests

The executable suite lives in the app and runs without Foundry, using an in-memory EVM (`@ethereumjs/evm`) and viem:

```
cd frontend && npx vitest run lib/chain/contracts.test.ts     # or: npm run contracts:test
```

It covers the constructor checks, onlyArena on every privileged function, the split math (an odd fee, plus a property check over many fees and splits), `WrongFee`, `Replay` and `Expired`, release payouts (exact balance delta), every signature failure (wrong signer, tampered fields, wrong domain, high-s malleation, 64-byte and garbage signatures), free-siege protection (`msg.value == 0` gives `WrongFee`), close and withdraw, reentrancy through a malicious castellan contract, and the solvency invariant `balance == Σ pots + Σ castellanBalance + arenaBalance`. The invariant is checked over a scripted sequence and over a 150-step seeded random walk.

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

- **Effects before interactions.** `release`, `closeVault`, `withdraw` and `withdrawArena` zero balances and set status before they make the external call. A re-entering castellan contract is paid exactly once (covered by a test).
- **Signatures.** Only 65-byte signatures are accepted. High-s signatures (EIP-2) are rejected, as is `v` outside {27, 28} (0 and 1 are normalised). A zero recovery is also rejected. The domain separator binds the chain id and the contract address.
- **Replay.** Each `siegeId` settles on chain at most once, across all vaults and for both attempt and release.
- **Free sieges** can never pay out. `release` requires `msg.value == fee`, and the arena only forwards a fee that a Raider actually paid.
- **Arena key alone** cannot drain pots, because `release` needs the verifier signature. What it can do: open vaults, record attempts (which only add funds), close expired vaults (the refund goes to the castellan) and withdraw its own 5%. **Arena key plus verifier key together** can pay any open pot to any address, so do not keep both in one long-lived hot process if it can be avoided.
- **Release after the deadline** is allowed while a vault is still `Open`, so a siege that is in flight when the deadline passes can still be paid. Once anyone calls `closeVault` the vault is final.
- If a castellan is a contract that rejects HBAR, its refund and withdraw revert (`PayFailed`) and its funds stay in the contract. If a Raider rejects payment, `release` reverts and leaves the vault untouched.
