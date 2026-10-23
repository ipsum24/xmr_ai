import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { TxResult } from "../components/TxResult";
import { useAuth } from "../components/AuthProvider";
import { Badge, ErrorBox, Field, Panel } from "../components/ui";
import { api, type BroadcastResult, type ChainFleet, type TransactionRecord, type Wallet } from "../lib/api";
import { chainLabel, rawToHuman, relativeTime, shorten } from "../lib/format";

export function WalletsPage() {
  const { admin } = useAuth();
  const fleetQuery = useQuery({ queryKey: ["fleet"], queryFn: () => api.get<ChainFleet>("/api/chains") });
  const txQuery = useQuery({
    queryKey: ["transactions", "recent"],
    queryFn: () => api.get<TransactionRecord[]>("/api/transactions?limit=25"),
    refetchInterval: 5000,
  });

  const chains = (fleetQuery.data?.chains ?? []).filter((c) => c.status === "ready");

  const [chain, setChain] = useState("");
  const [token, setToken] = useState<"wusdt" | "usdt">("wusdt");
  const [walletId, setWalletId] = useState("");
  const [toAddress, setToAddress] = useState("");
  const [amount, setAmount] = useState("1000");
  const [result, setResult] = useState<BroadcastResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const walletsForChain = chains.find((c) => c.chain === chain)?.wallets ?? [];
  const chainTxs = (txQuery.data ?? []).filter((tx) => tx.chain === chain);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await api.post<BroadcastResult>("/api/wallets/transfer", {
          chain,
          token,
          walletId,
          toAddress,
          amountHuman: amount,
        }),
      );
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">App wallets</h1>
          <p className="page-sub">
            The vault plus the app wallets seeded by each mint cycle's distribution. Balances are mirrored from
            <span className="mono"> balanceOf</span> on chain after every confirmed transaction — the chain is the source of
            truth.
          </p>
        </div>
        <Badge kind="gold">{admin?.email}</Badge>
      </div>

      <div className="grid">
        {chains.map((chainInfo) => (
          <Panel key={chainInfo.chain} title={chainLabel(chainInfo.chain)} hint={`${chainInfo.dexName} · ${chainInfo.mode}`}>
            <table>
              <thead>
                <tr>
                  <th>Wallet</th>
                  <th>Address</th>
                  <th style={{ textAlign: "right" }}>wUSDT</th>
                  <th style={{ textAlign: "right" }}>USDT</th>
                </tr>
              </thead>
              <tbody>
                {chainInfo.wallets.map((wallet: Wallet) => (
                  <tr key={wallet.id}>
                    <td>
                      {wallet.label}
                      {wallet.kind === "treasury" ? (
                        <>
                          {" "}
                          <Badge kind="gold">vault</Badge>
                        </>
                      ) : null}
                    </td>
                    <td className="mono" title={wallet.address}>
                      {shorten(wallet.address, 10, 6)}
                    </td>
                    <td className="mono" style={{ textAlign: "right" }}>
                      {rawToHuman(wallet.balances.find((b) => b.symbol === "wUSDT")?.availableRaw, chainInfo.wusdtDecimals, 2)}
                    </td>
                    <td className="mono" style={{ textAlign: "right" }}>
                      {rawToHuman(wallet.balances.find((b) => b.symbol === "USDT")?.availableRaw, chainInfo.usdtDecimals, 2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        ))}
      </div>

      <div className="grid" style={{ marginTop: 18 }}>
        <Panel title="Transfer out" hint="A real broadcast from a platform wallet to an external address.">
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
          <Field label="Token">
            <select value={token} onChange={(e) => setToken(e.target.value as "wusdt" | "usdt")}>
              <option value="wusdt">wUSDT (wrapped platform token)</option>
              <option value="usdt">USDT (official contract)</option>
            </select>
          </Field>
          <Field label="From wallet">
            <select value={walletId} onChange={(e) => setWalletId(e.target.value)}>
              <option value="">Select a wallet…</option>
              {walletsForChain.map((wallet) => (
                <option key={wallet.id} value={wallet.id}>
                  {wallet.label} —{" "}
                  {rawToHuman(wallet.balances.find((b) => b.symbol === (token === "wusdt" ? "wUSDT" : "USDT"))?.availableRaw, 6, 2)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Recipient address">
            <input value={toAddress} onChange={(e) => setToAddress(e.target.value)} placeholder="0x…" />
          </Field>
          <Field label="Amount">
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          </Field>
          <button className="btn btn-primary" type="button" disabled={!chain || !walletId || !toAddress || busy} onClick={() => void submit()}>
            {busy ? "Broadcasting…" : "Transfer"}
          </button>
          <TxResult result={result} />
          <ErrorBox error={error} />
        </Panel>

        <Panel title="Recent chain activity" hint={chain ? `Latest 25 broadcasts on ${chainLabel(chain)}` : "Pick a chain to filter"}>
          {chainTxs.length === 0 ? (
            <p className="muted" style={{ fontSize: 13, margin: 0 }}>
              No transactions recorded for this chain yet.
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Direction</th>
                  <th>Hash</th>
                  <th>Status</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {chainTxs.map((tx) => (
                  <tr key={tx.id}>
                    <td>{tx.direction.replace(/_/g, " ")}</td>
                    <td className="mono">
                      {tx.hash ? (
                        tx.explorerUrl ? (
                          <a href={tx.explorerUrl} target="_blank" rel="noreferrer">
                            {shorten(tx.hash, 10, 6)}
                          </a>
                        ) : (
                          <span title={tx.hash}>{shorten(tx.hash, 10, 6)}</span>
                        )
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      <Badge kind={tx.status === "confirmed" ? "success" : tx.status === "failed" ? "danger" : "gold"}>
                        {tx.status}
                      </Badge>
                    </td>
                    <td className="muted">{relativeTime(tx.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </>
  );
}
