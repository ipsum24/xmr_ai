# Contracts

Solidity sources for the wUSDT fleet.

| File | Role |
|---|---|
| `src/WrappedUSDT.sol` | wUSDT itself — mint is minter-only (the Treasury Vault signer), burn on redemption |
| `src/MockUSDT.sol` | **devnet only** stand-in for Tether's own USDT contract, same interface, same per-chain decimals (6, 18 on BSC) |
| `src/LocalDexRouter.sol` | **devnet only** stand-in for the chain's DEX router (0.05 % fee tier, real reserves) |

## Devnet vs live

- **Live mode** (`CHAIN_MODE=live`): the platform talks to the official USDT
  contract from `shared/chains.ts`, to the deployed `WrappedUSDT` address from
  the environment, and to the chain's real DEX router. `MockUSDT` and
  `LocalDexRouter` are never deployed or contacted.
- **Devnet mode** (`CHAIN_MODE=devnet`, the sandbox default): each EVM chain is
  a local Anvil node with its own chain id. The API compiles these sources with
  `solc`, deploys the three contracts on boot (idempotently — a redeploy only
  happens if the node lost state), and funds devnet-only balances (custody
  USDT + DEX reserves). Every mint, burn, transfer, swap and liquidation is then
  a **real EVM transaction with a real, verifiable hash and receipt** — just on a
  local chain instead of mainnet.

The Foundry `WrappedUSDT` and a `TreasuryLendingEngine` invariant suite are not
part of this slice; see the "Not built yet" section of the root README.
