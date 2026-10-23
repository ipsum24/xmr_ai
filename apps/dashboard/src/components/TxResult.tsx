import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type BroadcastResult, type TransactionRecord } from "../lib/api";
import { chainLabel, relativeTime, shorten } from "../lib/format";
import { Badge, ErrorBox, StatusBadge } from "./ui";

/**
 * Live receipt card for a broadcast.
 *
 * The hash shown is the one the node returned. The card polls the transaction
 * until the handshake watcher flips it to confirmed, so the badge goes
 * pending_broadcast → broadcasting → confirmed on its own.
 */
export function TxResult({ result }: { result: BroadcastResult | null }) {
  const [copied, setCopied] = useState(false);

  const txQuery = useQuery({
    queryKey: ["transaction", result?.txId],
    queryFn: () => api.get<TransactionRecord>(`/api/transactions/${result!.txId}`),
    enabled: Boolean(result?.txId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "broadcasting" || status === "pending_broadcast" ? 2000 : false;
    },
  });

  if (!result) return null;
  const tx = txQuery.data;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(result.hash);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="tx-result">
      <div className="btn-row" style={{ justifyContent: "space-between" }}>
        <strong style={{ fontSize: 13 }}>
          {chainLabel(result.chain)} · {result.direction.replace(/_/g, " ")} · {result.amountHuman} {result.tokenSymbol}
        </strong>
        <StatusBadge status={tx?.status ?? "pending_broadcast"} />
      </div>

      <div className="tx-hash">{result.hash}</div>

      <div className="btn-row">
        <button className="btn btn-ghost" onClick={copy} type="button">
          {copied ? "Copied" : "Copy hash"}
        </button>
        {result.explorerUrl ? (
          <a className="btn btn-ghost" href={result.explorerUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
            View on explorer ↗
          </a>
        ) : (
          <span className="muted" style={{ fontSize: 12.5 }}>
            local devnet chain — no public explorer for this hash
          </span>
        )}
        {result.dex && <Badge kind="info">{result.dex}</Badge>}
      </div>

      {tx && (
        <div style={{ marginTop: 10 }}>
          <div className="kv">
            <span className="muted">confirmations</span>
            <span className="mono">{tx.confirmations}</span>
          </div>
          <div className="kv">
            <span className="muted">block</span>
            <span className="mono">{tx.blockNumber ?? "—"}</span>
          </div>
          <div className="kv">
            <span className="muted">from → to</span>
            <span className="mono">
              {shorten(tx.fromAddress)} → {shorten(tx.toAddress)}
            </span>
          </div>
          <div className="kv">
            <span className="muted">hash source</span>
            <span className="mono">{tx.hashSource ?? "awaiting broadcaster"}</span>
          </div>
          <div className="kv">
            <span className="muted">broadcast</span>
            <span>{relativeTime(tx.createdAt)}</span>
          </div>
        </div>
      )}

      {tx?.failureReason && <ErrorBox error={tx.failureReason} />}
      {txQuery.error && <ErrorBox error={txQuery.error} />}
      {result.approvalTxId && (
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
          Exact-amount approval broadcast first (approve(0) → approve(exact)), then the swap.
        </p>
      )}
    </div>
  );
}
