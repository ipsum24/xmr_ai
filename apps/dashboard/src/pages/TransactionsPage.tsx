import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge, Panel, StatusBadge } from "../components/ui";
import { api, type TransactionRecord } from "../lib/api";
import { chainLabel, rawToHuman, relativeTime, shorten } from "../lib/format";

const STATUSES = ["all", "pending_broadcast", "broadcasting", "confirmed", "failed"];

export function TransactionsPage() {
  const [status, setStatus] = useState("all");

  const txQuery = useQuery({
    queryKey: ["transactions", status],
    queryFn: () =>
      api.get<TransactionRecord[]>(`/api/transactions?limit=100${status === "all" ? "" : `&status=${status}`}`),
    refetchInterval: 4000,
  });

  const transactions = txQuery.data ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Transaction record</h1>
          <p className="page-sub">
            Every broadcast the platform made, with its real hash, hash source and confirmation state. A hash is
            write-once and can only be attached by the broadcaster — nothing in this console can enter one.
          </p>
        </div>
        <Badge kind="neutral">{transactions.length} rows</Badge>
      </div>

      <Panel>
        <div className="chips">
          {STATUSES.map((option) => (
            <button
              key={option}
              type="button"
              className={`chip${status === option ? " active" : ""}`}
              onClick={() => setStatus(option)}
            >
              {option.replace(/_/g, " ")}
            </button>
          ))}
        </div>

        {transactions.length === 0 ? (
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            No transactions match this filter.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Chain</th>
                <th>Direction</th>
                <th style={{ textAlign: "right" }}>Amount</th>
                <th>Hash</th>
                <th>Status</th>
                <th>Confirmations</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((tx) => (
                <tr key={tx.id}>
                  <td>{chainLabel(tx.chain)}</td>
                  <td>
                    {tx.direction.replace(/_/g, " ")}
                    {tx.note ? <div className="muted" style={{ fontSize: 11.5 }}>{tx.note}</div> : null}
                  </td>
                  <td className="mono" style={{ textAlign: "right" }}>
                    {rawToHuman(tx.amount, tx.decimals)} {tx.tokenSymbol}
                  </td>
                  <td className="mono">
                    {tx.hash ? (
                      tx.explorerUrl ? (
                        <a href={tx.explorerUrl} target="_blank" rel="noreferrer" title={tx.hash}>
                          {shorten(tx.hash, 8, 6)} ↗
                        </a>
                      ) : (
                        <span title={tx.hash}>{shorten(tx.hash, 8, 6)}</span>
                      )
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    <StatusBadge status={tx.status} />
                    {tx.failureReason && (
                      <div className="muted" style={{ fontSize: 11.5, maxWidth: 220 }}>
                        {tx.failureReason}
                      </div>
                    )}
                  </td>
                  <td className="mono">{tx.confirmations}</td>
                  <td className="muted">{relativeTime(tx.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}
