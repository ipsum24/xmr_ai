import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { TxResult } from "../components/TxResult";
import { Badge, ErrorBox, Field, Panel } from "../components/ui";
import { api, type BroadcastResult, type ChainFleet, type LoanQuote } from "../lib/api";
import { chainLabel } from "../lib/format";

interface LiquidateResult {
  swap: BroadcastResult;
  forward: BroadcastResult;
  proceedsHuman: string;
}

export function OrchestratorPage() {
  const fleetQuery = useQuery({ queryKey: ["fleet"], queryFn: () => api.get<ChainFleet>("/api/chains") });
  const chains = (fleetQuery.data?.chains ?? []).filter((c) => c.status === "ready");

  const [chain, setChain] = useState("");
  const [walletId, setWalletId] = useState("");
  const [toExternal, setToExternal] = useState("");
  const [transferAmount, setTransferAmount] = useState("10000");
  const [swapAmount, setSwapAmount] = useState("5000");
  const [minOut, setMinOut] = useState("4990");
  const [liquidateAmount, setLiquidateAmount] = useState("5000");
  const [slippageBps, setSlippageBps] = useState(50);

  const [transferResult, setTransferResult] = useState<BroadcastResult | null>(null);
  const [swapResult, setSwapResult] = useState<BroadcastResult | null>(null);
  const [liquidateResult, setLiquidateResult] = useState<LiquidateResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const wallets = chains.find((c) => c.chain === chain)?.wallets ?? [];
  const selectedWallet = wallets.find((w) => w.id === walletId);
  const wusdtBalance = selectedWallet?.balances.find((b) => b.symbol === "wUSDT")?.availableHuman ?? "0";

  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Orchestrator</h1>
          <p className="page-sub">
            Three chained operations, each its own broadcast: unlock &amp; transfer wUSDT out, swap wUSDT → official USDT
            on the chain's DEX, or liquidate and forward the proceeds. Every panel shows the real hash the node returned —
            there is no field anywhere that accepts one.
          </p>
        </div>
      </div>

      <div className="grid">
        <Panel title="1 · Unlock &amp; transfer" hint="Moves wUSDT from a treasury or app wallet to an external wallet.">
          <Field label="Chain">
            <select
              value={chain}
              onChange={(e) => {
                setChain(e.target.value);
                setWalletId("");
              }}
            >
              <option value="">Select a chain…</option>
              {chains.map((c) => (
                <option key={c.chain} value={c.chain}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="From wallet">
            <select value={walletId} onChange={(e) => setWalletId(e.target.value)}>
              <option value="">Select a wallet…</option>
              {wallets.map((wallet) => (
                <option key={wallet.id} value={wallet.id}>
                  {wallet.label} — {wallet.balances.find((b) => b.symbol === "wUSDT")?.availableHuman ?? "0"} wUSDT
                </option>
              ))}
            </select>
          </Field>
          <Field label="External recipient address">
            <input value={toExternal} onChange={(e) => setToExternal(e.target.value)} placeholder="0x…" />
          </Field>
          <Field label={`Amount (wUSDT) — available ${wusdtBalance}`}>
            <input value={transferAmount} onChange={(e) => setTransferAmount(e.target.value)} inputMode="decimal" />
          </Field>
          <button
            className="btn btn-primary"
            type="button"
            disabled={!chain || !walletId || !toExternal || busy !== null}
            onClick={() =>
              act("transfer", async () => {
                setTransferResult(null);
                setTransferResult(
                  await api.post<BroadcastResult>("/api/orchestrator/unlock-transfer", {
                    chain,
                    walletId,
                    toExternal,
                    amountHuman: transferAmount,
                  }),
                );
              })
            }
          >
            {busy === "transfer" ? "Broadcasting…" : "Unlock & transfer"}
          </button>
          <TxResult result={transferResult} />
        </Panel>

        <Panel title="2 · Swap wUSDT → USDT" hint="Exact-amount approval first (approve(0) → approve(exact)), then the DEX swap.">
          <Field label="Chain">
            <select
              value={chain}
              onChange={(e) => {
                setChain(e.target.value);
                setWalletId("");
              }}
            >
              <option value="">Select a chain…</option>
              {chains.map((c) => (
                <option key={c.chain} value={c.chain}>
                  {c.label} · {c.dexName}
                </option>
              ))}
            </select>
          </Field>
          <Field label="From wallet">
            <select value={walletId} onChange={(e) => setWalletId(e.target.value)}>
              <option value="">Select a wallet…</option>
              {wallets.map((wallet) => (
                <option key={wallet.id} value={wallet.id}>
                  {wallet.label} — {wallet.balances.find((b) => b.symbol === "wUSDT")?.availableHuman ?? "0"} wUSDT
                </option>
              ))}
            </select>
          </Field>
          <Field label="Amount in (wUSDT)">
            <input value={swapAmount} onChange={(e) => setSwapAmount(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Minimum out (USDT)">
            <input value={minOut} onChange={(e) => setMinOut(e.target.value)} inputMode="decimal" />
          </Field>
          <button
            className="btn btn-primary"
            type="button"
            disabled={!chain || !walletId || busy !== null}
            onClick={() =>
              act("swap", async () => {
                setSwapResult(null);
                setSwapResult(
                  await api.post<BroadcastResult>("/api/orchestrator/swap", {
                    chain,
                    walletId,
                    amountHuman: swapAmount,
                    minOutHuman: minOut,
                  }),
                );
              })
            }
          >
            {busy === "swap" ? "Broadcasting…" : "Swap to USDT"}
          </button>
          <TxResult result={swapResult} />
        </Panel>

        <Panel
          title="3 · Liquidate &amp; forward"
          hint="Liquidates wUSDT on the DEX, waits for the receipt, then forwards exactly the USDT the swap produced."
        >
          <Field label="Chain">
            <select
              value={chain}
              onChange={(e) => {
                setChain(e.target.value);
                setWalletId("");
              }}
            >
              <option value="">Select a chain…</option>
              {chains.map((c) => (
                <option key={c.chain} value={c.chain}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="From wallet">
            <select value={walletId} onChange={(e) => setWalletId(e.target.value)}>
              <option value="">Select a wallet…</option>
              {wallets.map((wallet) => (
                <option key={wallet.id} value={wallet.id}>
                  {wallet.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Amount to liquidate (wUSDT)">
            <input value={liquidateAmount} onChange={(e) => setLiquidateAmount(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="External recipient (receives USDT)">
            <input value={toExternal} onChange={(e) => setToExternal(e.target.value)} placeholder="0x…" />
          </Field>
          <Field label={`Slippage budget — ${(slippageBps / 100).toFixed(2)}%`}>
            <input
              type="range"
              min={1}
              max={300}
              value={slippageBps}
              onChange={(e) => setSlippageBps(Number(e.target.value))}
            />
          </Field>
          <button
            className="btn btn-primary"
            type="button"
            disabled={!chain || !walletId || !toExternal || busy !== null}
            onClick={() =>
              act("liquidate", async () => {
                setLiquidateResult(null);
                setLiquidateResult(
                  await api.post<LiquidateResult>("/api/orchestrator/liquidate-forward", {
                    chain,
                    walletId,
                    toExternal,
                    amountHuman: liquidateAmount,
                    slippageBps,
                  }),
                );
              })
            }
          >
            {busy === "liquidate" ? "Liquidating…" : "Liquidate & forward"}
          </button>

          {liquidateResult && (
            <>
              <div className="btn-row" style={{ marginTop: 12 }}>
                <Badge kind="success">{liquidateResult.proceedsHuman} USDT forwarded</Badge>
                <Badge kind="neutral">swap {chainLabel(liquidateResult.swap.chain)}</Badge>
              </div>
              <TxResult result={liquidateResult.forward} />
              <details style={{ marginTop: 10 }}>
                <summary className="muted" style={{ fontSize: 12.5, cursor: "pointer" }}>
                  Liquidation leg (swap) detail
                </summary>
                <TxResult result={liquidateResult.swap} />
              </details>
            </>
          )}
        </Panel>
      </div>

      <div style={{ marginTop: 18 }}>
        <ErrorBox error={error ?? fleetQuery.error} />
      </div>

      <Panel
        title="How this stays honest"
        hint="From the platform's own rules — worth keeping in view while operating the panels."
      >
        <ul className="list-reset" style={{ fontSize: 13, lineHeight: 1.7 }}>
          <li>
            A confirmation can never be <em>entered</em> — it is derived from a broadcast this system made. The hash is
            write-once and attached only by the broadcaster.
          </li>
          <li>
            The explorer link is derived from (chain, hash) at confirmation time, never supplied by a client.
          </li>
          <li>
            On a local devnet chain there is no public explorer, so the console shows the real hash without pretending a
            public explorer can resolve it.
          </li>
          <li>
            Swaps route through the chain's DEX contract with exact-amount approvals — no infinite approvals.
          </li>
        </ul>
      </Panel>
    </>
  );
}
