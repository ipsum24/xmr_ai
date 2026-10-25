# Launch tooling — devnet → mainnet

Ordered, fail-closed gates that take this platform from a local devnet stack to
live mainnet chains: **Ethereum, BNB Chain, Arbitrum One, Polygon**. Each gate
must pass before the next one is allowed to touch money. TRON is out of scope —
only the EVM broadcaster path is implemented (`swapWusdtForUsdt` throws for TRON).

Run everything inside the API container, which has the environment, the RPC
network access and `DATABASE_URL`:

```bash
docker compose exec -T api npx tsx services/api/scripts/launch/preflight.ts
```

`--chains=ethereum,bsc` (or `LAUNCH_CHAINS=…`) narrows a run; the default is the
whole EVM fleet.

## 0 — pre-flight (`preflight.ts`, no transactions)

Proves the machine is set up for a real mainnet launch:

- `CHAIN_MODE=live`, `NODE_ENV=production`, no `MOCK_`/`SIMULATE_`/`FAKE_`/
  `DEMO_MODE`/`SEED_DEMO` switches present, `DATABASE_URL` set;
- a valid `LIVE_SIGNER_PRIVATE_KEY` whose address holds gas on every chain;
- per chain: the RPC answers with **the chain id from the chain registry** — a
  test-network endpoint cannot pass as production, whatever its URL looks like;
- per chain: Tether's own USDT contract from `shared/chains.ts` has code at its
  canonical address and reports the registry's decimals (6, and **18 on BSC**) —
  a chain id alone can be faked by a local node, this cannot.

Fails closed and prints exactly which variables to supply.

## 1 — deploy the reserve fleet (`deploy-fleet.ts`, broadcasts)

Compiles `WrappedUSDT` **and** `TreasuryVault` from this checkout's own source and
deploys the pair on each chain with the correct decimals for that chain, then
wires the reserve model the enhanced design requires:

1. deploy `wUSDT` (governor = the deploy key, this chain's USDT decimals);
2. deploy `TreasuryVault(wUSDT, governor = the deploy key, same decimals)`;
3. `setMinter(<vault>)` — the vault becomes the token's **only** minter, so no
   key can create supply and every mint goes through the replay-protected
   `injectNetReserve`;
4. grant the vault's `BRIDGE_ROLE` and `OPERATOR_ROLE` to the custody signer, so
   it can inject a cycle, distribute the 25 % batch and release a redemption;
5. when `LAUNCH_GOVERNOR` names a multisig, hand governance of **both** contracts
   over — the deploy key keeps no authority (pausing and admin stay with
   governance).

Sequential, one chain at a time, the wired fleet read back before the next
deploy. A chain whose `WUSDT_<CHAIN>`/`TREASURY_VAULT_<CHAIN>` pair is already set
is skipped only when it is complete and correctly wired (vault = minter, bound to
the same token, right decimals, custody holds bridge + operator); anything else is
reported instead of redeployed. It prints both `…=0x…` lines to add to the live
environment.

## 2 — verify the fleet (`verify-fleet.ts`, reads only)

Reads every assertion back from mainnet: USDT decimals, deployed wUSDT identity
(`Wrapped USDT` / `wUSDT`) and decimals, **minter = the TreasuryVault** (never an
EOA), that vault bound to this token with the chain's decimals and the launch
target as its ceiling, the custody signer holding the vault's `BRIDGE_ROLE` and
`OPERATOR_ROLE`, the vault's shadow ledger reconciling (`reserveDrift() = 0`) and
not paused, governor = launch governance on both contracts, DEX router has code,
custody holds gas, and the reserve invariant `wUSDT.totalSupply() ≤ custodied
USDT`. Any mismatch stops the launch.

## 3 — gas float (`gas-forward.ts`, broadcasts native value)

Every wallet here signs its own transactions, so every wallet has to be able to
pay its own gas. This step forwards a native-gas float from the custody key to
each recipient on all four chains — recipients are `GAS_FORWARD_TO_<CHAIN>`, else
`GAS_FORWARD_TO`, else `APP_WALLET_ADDRESSES`:

- the float is sized from **live fee data** (`getFeeData`) ×
  `GAS_FLOAT_TRANSFERS` (default 10) × 65 000 gas per transfer — no hardcoded
  prices, and a zero/stale fee answer is a hard stop;
- idempotent — a wallet already holding the float is skipped, so a re-run sends
  nothing;
- fail-closed — live mode only, the chain must answer with the registry chain id,
  and custody must still cover its own launch budget (`50 000 000` gas at the
  same live fee) *after* the float, otherwise **nothing** is broadcast on that
  chain;
- after the top-up it asserts each recipient can now pay for a wUSDT transfer at
  current fees, and re-reads every balance to confirm the float landed.

Run it after Gate 2 (the fleet is deployed) and before Gate 4, so the app wallets
and the ops address can pay for the transfers the smoke cycle and the console
make from them:

```bash
docker compose exec -T api npx tsx services/api/scripts/launch/gas-forward.ts
```

## 4 — smoke cycle (`smoke-cycle.ts`, real funds, small)

Per chain, using the platform's own engines (not a reimplementation):

| Step | Action |
|---|---|
| 1 | read the attested reserve from chain — must cover $10k |
| 2 | `runMintCycle(chain, 10_000)` — the platform's mint engine, $10k |
| 3 | the 25 % app-wallet distribution that cycle performs (needs `APP_WALLET_ADDRESSES`) |
| 4 | transfer-out $100 wUSDT to `GATE4_EXTERNAL_ADDRESS` |
| 5 | swap $500 wUSDT → USDT on the chain's real DEX router |
| 6 | liquidate $100 and forward the USDT the swap actually produced |
| 7 | verify each broadcast: broadcaster hash, receipt re-read from an **independent** endpoint (`<RPC>_2`), the platform ledger row confirmed, chain supply delta, USDT received at the external address, webhook deliveries, explorer deep-link probe |

`GATE4_EXTERNAL_ADDRESS` (an ops-owned address) is required. The mint-cycle row
is capped at `SMOKE_LOCK_USD` so the first real cycle is small: the full $10M
target runs from the console afterwards (`POST /api/treasury/refill`), once the
governor multisig has raised the caps.

## Environment

| Variable | Needed by | Meaning |
|---|---|---|
| `CHAIN_MODE=live` | all | the platform's live chain mode |
| `NODE_ENV=production` | all | activates the runtime guard (`assertRuntimeMode`) |
| `LIVE_SIGNER_PRIVATE_KEY` | 1, 2, 3, 4 | custody key: deploys, pays the gas float, and holds the vault's `BRIDGE_ROLE` + `OPERATOR_ROLE` (it can never mint) |
| `ETH_RPC` `BSC_RPC` `ARB_RPC` `POLY_RPC` | all | mainnet endpoints (same names live mode reads) |
| `ETH_RPC_2` … (optional) | 4 | second endpoint for the independent receipt re-read |
| `LAUNCH_GOVERNOR` (optional) | 1, 2 | multisig that receives governance of the token **and** the vault |
| `WUSDT_<CHAIN>` | 1 (skip), 2, 4 | deployed wUSDT address — Gate 1 prints it |
| `TREASURY_VAULT_<CHAIN>` | 1 (skip), 2, 4 | deployed TreasuryVault (wUSDT's only minter) — Gate 1 prints it; live mode reads it into the ledger |
| `TREASURY_VAULT_TARGET_USD` (optional, default 10000000) | 2 | the reserve ceiling Gate 2 expects on a fresh vault |
| `SWAP_ROUTER_<CHAIN>`, `SWAP_DEX_<CHAIN>` | 2, 4 | the chain's real DEX router and its name |
| `APP_WALLET_ADDRESSES` | 3, 4 | comma-separated app wallet addresses |
| `GAS_FORWARD_TO`, `GAS_FORWARD_TO_<CHAIN>` (optional) | 3 | gas-float recipients, chain override first; defaults to `APP_WALLET_ADDRESSES` |
| `GAS_FLOAT_TRANSFERS` (optional, default 10) | 3 | transfers the forwarded float must cover |
| `GATE4_EXTERNAL_ADDRESS` | 4 | ops-owned address the smoke cycle transfers out to |
| `DATABASE_URL` | 4 | platform ledger |

Real values belong in the platform's encrypted secret store (delivered to
`/run/base44/app.env`) — never in the repo. `LIVE_SIGNER_PRIVATE_KEY` is the only
value here that is a secret in the credential sense; it is also the one that must
never be shared, since whoever holds it can move the reserve.

`WUSDT_<CHAIN>` and `TREASURY_VAULT_<CHAIN>` are **outputs** of Gate 1: run the
gate, then store the two lines it prints and re-run Gate 2. Live mode refuses to
register a chain without `WUSDT_<CHAIN>` and warns loudly when the vault address
is missing, because without it the reserve model has no contract to mint through.

### Where the values come from

| Value | Provider / where to get it |
|---|---|
| `ETH_RPC`, `ARB_RPC`, `POLY_RPC` | Alchemy dashboard → Create app → HTTPS URL (`https://eth-mainnet.g.alchemy.com/v2/<key>`, `…arb-mainnet…`, `…polygon-mainnet…`), or Infura (`https://mainnet.infura.io/v3/<key>`) |
| `BSC_RPC` | QuickNode → Create BSC endpoint (`https://<endpoint>.bsc.quiknode.pro/<token>/`), or any BSC archive node you control |
| `*_RPC_2` | a **different** provider for the same chain — an independent endpoint is the point of the Gate 4 receipt re-read |
| `LIVE_SIGNER_PRIVATE_KEY` | the custody account's key from your signer/KMS export; it must be funded with native gas on all four chains |
| `SWAP_ROUTER_<CHAIN>` | the chain's own DEX: Uniswap V3 `SwapRouter02` on Ethereum/Arbitrum/Polygon, PancakeSwap V3 on BSC |
| `GATE4_EXTERNAL_ADDRESS` | an ops-owned address you control the key for (it receives the smoke cycle's test funds) |

Endpoint URLs carry the provider key, so they are credentials: store them in the
secret store, never in compose, the repo or a gate report. TRON's TronGrid key is
header-based and TRON is out of scope in this slice.

## Guarantees this tooling keeps

- **No hash is ever entered.** A transaction hash is write-once and set only by
  the broadcaster (`attachHash`); there is no API or form that accepts one. Gate 4
  therefore *derives* its hashes from broadcasts and re-reads their receipts.
- **Nothing runs on test networks in a launch.** Live mode plus the chain-id
  comparison makes a testnet RPC a hard failure; `assertRuntimeMode` refuses to
  boot production with a mock switch or a non-live mode.
- **Minting stays reserve-backed.** Both the mint cycle and Gate 4's small cycle
  go through the same `mintCapacityRaw` gate, so supply can never exceed
  custodied USDT.

## Not covered here

- **TRON** (signer, SunSwap swap path) — not implemented in this slice.
- **Kubernetes rollout** — this repo has no cluster manifests; the API and console
  deploy however the operator runs the stack (docker compose).
- **Vault/staking/lending contracts** from the build spec — not in this slice; the
  production contracts here are `WrappedUSDT` **and** `TreasuryVault`
  (`contracts/README.md`), both deployed by Gate 1.
- **DEX pool seeding** — needs real USDT capital; the swap step in Gate 4 needs an
  existing pool with liquidity for the configured router.
