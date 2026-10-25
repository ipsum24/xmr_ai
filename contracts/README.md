# Contracts

Solidity sources for the wUSDT fleet.

| File | Role |
|---|---|
| `src/WrappedUSDT.sol` | wUSDT itself — mint is minter-only (the TreasuryVault), burn/redemption on the way out, role-separated and pausable |
| `src/TreasuryVault.sol` | the shadow reserve: replay-protected bridge injections, the 25 % distribution cycle, releases and redemption confirmation |
| `src/MockUSDT.sol` | **devnet only** stand-in for Tether's own USDT contract, same interface, same per-chain decimals (6, 18 on BSC) |
| `src/LocalDexRouter.sol` | **devnet only** stand-in for the chain's DEX router (0.05 % fee tier, real reserves) |

## The reserve model

Minting is a two-role affair, and neither role is an EOA:

- `WrappedUSDT` grants `MINTER_ROLE` to the **TreasuryVault** only
  (`setMinter(vault)`), so supply can never appear from a signature alone;
- the vault mints in exactly one place — `injectNetReserve(messageId, amount)` —
  which is `BRIDGE_ROLE` (the custody signer), refuses a replayed `messageId`,
  and refuses to push `currentReserve` past `maxReserve` (the $10M target by
  default, raisable by governance for a refill);
- `currentReserve` is a **shadow ledger**, not `balanceOf`: the ledger is what
  reserve arithmetic reads, and `expectedVaultBalance()` /
  `reserveDrift()` reconcile it against the tokens the vault actually holds.

Outflows, each on its own path:

| Path | Role | Effect |
|---|---|---|
| `distributeToAppWallets(wallets)` | `OPERATOR_ROLE` | 25 % of `currentReserve`, bounded to `MAX_BATCH = 200`; un-splittable dust stays in the reserve |
| `releaseReserve(to, amount)` | `OPERATOR_ROLE` | the platform's own payout (console transfer-out, swap, liquidation) |
| `confirmRedemption(requestId, user, amount)` | `OPERATOR_ROLE` | records the source-chain release for a holder's `requestRedemption`, once per id |
| `pause()` / `unpause()` | `PAUSER_ROLE` | emergency stop over mint, distribution, releases and transfers |

`WrappedUSDT.requestRedemption(amount)` is permissionless: the holder burns and a
replay-safe `requestId` (sender, amount, nonce, chain id) is emitted for the
relayer, which the operator then confirms on the vault. That closes the burn →
real-USDT-release loop.

**Decimals.** `decimals` is constructor-set to the chain's official USDT decimals
(6, and **18 on BNB Chain**) — never a hardcoded `1e6`. The review's "10¹²
decimals bug" is what this avoids; the vault sizes its cap from the same number.

## Devnet vs live

- **Live mode** (`CHAIN_MODE=live`): the platform talks to the official USDT
  contract from `shared/chains.ts`, to the deployed `WrappedUSDT`
  (`WUSDT_<CHAIN>`) and `TreasuryVault` (`TREASURY_VAULT_<CHAIN>`) addresses from
  the environment, and to the chain's real DEX router. `MockUSDT` and
  `LocalDexRouter` are never deployed or contacted. Gate 1 (`deploy-fleet.ts`)
  deploys both contracts and wires the roles; Gate 2 (`verify-fleet.ts`) reads
  the wiring back.
- **Devnet mode** (`CHAIN_MODE=devnet`, the sandbox default): each EVM chain is
  a local Anvil node with its own chain id. The API compiles these sources with
  `solc`, deploys the four contracts on boot (idempotently — a redeploy only
  happens if the node lost state or the vault is missing), wires the vault as
  the token's minter, and funds devnet-only balances (custody USDT + DEX
  reserves). Every mint, distribution, release, burn and swap is then a **real
  EVM transaction with a real, verifiable hash and receipt** — just on a local
  chain instead of mainnet.

A Foundry `contracts/test/` suite is still not part of this slice; the contracts
are exercised end to end by the devnet boot path and by the launch gates on a
local chain (see the "Not built yet" section of the root README).
