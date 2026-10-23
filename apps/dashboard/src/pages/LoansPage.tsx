import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { TxResult } from "../components/TxResult";
import { Badge, ErrorBox, Field, Panel, Stat } from "../components/ui";
import { api, type BroadcastResult, type ChainFleet, type CollateralAsset, type Loan, type LoanQuote, type TermTier } from "../lib/api";
import { chainLabel, rawToHuman, usd } from "../lib/format";

interface BorrowResult {
  loan: Loan;
  disbursement: BroadcastResult;
}

interface RepayResult {
  loan: Loan;
  repayment: BroadcastResult;
  interestEarnedRaw: string;
}

export function LoansPage() {
  const fleetQuery = useQuery({ queryKey: ["fleet"], queryFn: () => api.get<ChainFleet>("/api/chains") });
  const termsQuery = useQuery({ queryKey: ["terms"], queryFn: () => api.get<TermTier[]>("/api/lending/terms") });
  const loansQuery = useQuery({
    queryKey: ["loans"],
    queryFn: () => api.get<{ loans: Loan[]; totals: { activePrincipalRaw: string; interestBookedRaw: string } }>("/api/lending/loans"),
    refetchInterval: 10000,
  });

  const chains = (fleetQuery.data?.chains ?? []).filter((c) => c.status === "ready");
  const terms = termsQuery.data ?? [];

  const [chain, setChain] = useState("");
  const [term, setTerm] = useState("MONTH_12");
  const [principal, setPrincipal] = useState("10000");
  const [collateralId, setCollateralId] = useState("");
  const [collateralAmount, setCollateralAmount] = useState("");
  const [borrowerWalletId, setBorrowerWalletId] = useState("");
  const [borrowResult, setBorrowResult] = useState<BorrowResult | null>(null);
  const [repayResult, setRepayResult] = useState<RepayResult | null>(null);
  const [error, setError] = useState<unknown>(null);

  const chainInfo = chains.find((c) => c.chain === chain);

  const assetsQuery = useQuery({
    queryKey: ["collateral", chain],
    queryFn: () => api.get<CollateralAsset[]>(`/api/lending/assets?chain=${chain}`),
    enabled: Boolean(chain),
  });

  const quoteQuery = useQuery({
    queryKey: ["quote", chain, principal, term, collateralId],
    queryFn: () => api.post<LoanQuote>("/api/lending/quote", { chain, principalHuman: principal, term, collateralId }),
    enabled: Boolean(chain && principal && collateralId),
  });

  const quote = quoteQuery.data;
  const decimals = chainInfo?.usdtDecimals ?? 6;

  const suggestedCollateral = useMemo(() => {
    if (!quote) return "";
    // give the form a sane starting point from the engine's own requirement
    return quote.requiredCollateralHuman;
  }, [quote]);

  const loans = loansQuery.data?.loans ?? [];

  const borrow = async () => {
    setError(null);
    setBorrowResult(null);
    try {
      setBorrowResult(
        await api.post<BorrowResult>("/api/lending/borrow", {
          chain,
          borrowerWalletId,
          principalHuman: principal,
          term,
          collateralId,
          collateralHuman: collateralAmount || suggestedCollateral,
        }),
      );
      await loansQuery.refetch();
    } catch (err) {
      setError(err);
    }
  };

  const repay = async (loanId: string) => {
    setError(null);
    setRepayResult(null);
    try {
      setRepayResult(await api.post<RepayResult>("/api/lending/repay", { loanId }));
      await loansQuery.refetch();
    } catch (err) {
      setError(err);
    }
  };

  const liquidate = async (loanId: string) => {
    setError(null);
    try {
      await api.post("/api/lending/liquidate", { loanId });
      await loansQuery.refetch();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Lending book</h1>
          <p className="page-sub">
            Fixed-term, fixed-rate wUSDT borrow: 3.5 % / 6 % / 10 % / 15 % by term, interest locked at origination, and the
            vault's lendable supply is its real on-chain USDT balance — a loan can never exceed custodied USDT.
          </p>
        </div>
        <Badge kind={fleetQuery.data?.mode === "devnet" ? "neutral" : "gold"}>{fleetQuery.data?.mode} mode</Badge>
      </div>

      <div className="grid">
        <Panel title="Loan calculator" hint="Mirrors the engine's quote exactly — the number you see is the number charged.">
          <Field label="Chain">
            <select
              value={chain}
              onChange={(e) => {
                setChain(e.target.value);
                setCollateralId("");
                setBorrowerWalletId("");
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

          <Field label="Term">
            <div className="chips" style={{ marginBottom: 0 }}>
              {terms.map((tier) => (
                <button
                  key={tier.term}
                  type="button"
                  className={`chip${term === tier.term ? " active" : ""}`}
                  onClick={() => setTerm(tier.term)}
                >
                  {tier.label} · {(tier.aprBps / 100).toFixed(1)}%
                </button>
              ))}
            </div>
          </Field>

          <Field label="Principal (USDT)">
            <input value={principal} onChange={(e) => setPrincipal(e.target.value)} inputMode="decimal" />
          </Field>

          <Field label="Collateral asset">
            <select value={collateralId} onChange={(e) => setCollateralId(e.target.value)}>
              <option value="">Select collateral…</option>
              {(assetsQuery.data ?? []).map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.symbol} — {usd(rawToHuman(asset.priceRaw8, 8, 2))} · {(asset.ltvBps / 100).toFixed(0)}% LTV ·{" "}
                  {(asset.haircutBps / 100).toFixed(0)}% haircut
                </option>
              ))}
            </select>
          </Field>

          {quote ? (
            <div className="stat-row">
              <Stat label="interest due" value={usd(quote.interestHuman)} small />
              <Stat label="total repay" value={usd(quote.totalRepayHuman)} small />
              <Stat label="required collateral" value={`${Number(quote.requiredCollateralHuman).toLocaleString()} ${quote.collateral.symbol}`} small />
              <Stat label="effective APR" value={`${quote.effectiveAprPct.toFixed(2)}%`} small />
            </div>
          ) : (
            <p className="muted" style={{ fontSize: 13 }}>
              Pick a chain, principal and collateral to see the quote.
            </p>
          )}

          <ErrorBox error={quoteQuery.error} />
        </Panel>

        <Panel title="Originate a loan" hint="Disbursement is a real USDT broadcast from the vault to the borrower wallet.">
          <Field label="Borrower wallet">
            <select value={borrowerWalletId} onChange={(e) => setBorrowerWalletId(e.target.value)}>
              <option value="">Select a wallet…</option>
              {(chainInfo?.wallets ?? []).map((wallet) => (
                <option key={wallet.id} value={wallet.id}>
                  {wallet.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label={`Collateral amount${quote ? ` (min ${Number(quote.requiredCollateralHuman).toLocaleString()} ${quote.collateral.symbol})` : ""}`}>
            <input
              value={collateralAmount}
              onChange={(e) => setCollateralAmount(e.target.value)}
              placeholder={suggestedCollateral || "0.0"}
              inputMode="decimal"
            />
          </Field>
          <button
            className="btn btn-primary"
            type="button"
            disabled={!chain || !borrowerWalletId || !quote || !principal}
            onClick={() => void borrow()}
          >
            Borrow {usd(principal)}
          </button>

          {borrowResult && (
            <>
              <div className="btn-row" style={{ marginTop: 12 }}>
                <Badge kind="success">loan {borrowResult.loan.id.slice(0, 8)}… originated</Badge>
                <Badge kind="neutral">matures {new Date(borrowResult.loan.maturityAt).toLocaleDateString()}</Badge>
              </div>
              <TxResult result={borrowResult.disbursement} />
            </>
          )}

          {repayResult && (
            <>
              <div className="btn-row" style={{ marginTop: 12 }}>
                <Badge kind="success">loan repaid</Badge>
                <Badge kind="gold">interest earned {rawToHuman(repayResult.interestEarnedRaw, decimals)} USDT</Badge>
              </div>
              <TxResult result={repayResult.repayment} />
            </>
          )}

          <ErrorBox error={error} />
        </Panel>
      </div>

      <div style={{ marginTop: 18 }}>
        <Panel
          title="Book"
          hint={`Active principal ${usd(rawToHuman(loansQuery.data?.totals.activePrincipalRaw ?? "0", decimals))} · interest booked ${usd(
            rawToHuman(loansQuery.data?.totals.interestBookedRaw ?? "0", decimals),
          )}`}
        >
          {loans.length === 0 ? (
            <p className="muted" style={{ fontSize: 13, margin: 0 }}>
              No loans on the book yet.
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Chain</th>
                  <th>Principal</th>
                  <th>APR</th>
                  <th>Collateral</th>
                  <th>Matures</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {loans.map((loan) => (
                  <tr key={loan.id}>
                    <td>{chainLabel(loan.chain)}</td>
                    <td className="mono">{usd(rawToHuman(loan.principalRaw, decimals))}</td>
                    <td>{(loan.aprBps / 100).toFixed(1)}%</td>
                    <td className="mono">
                      {Number(rawToHuman(loan.collateralAmount, loan.collateralSymbol === "WETH" ? 18 : 6, 4)).toLocaleString()}{" "}
                      {loan.collateralSymbol}
                    </td>
                    <td className="muted">{new Date(loan.maturityAt).toLocaleDateString()}</td>
                    <td>
                      <Badge
                        kind={loan.status === "repaid" ? "success" : loan.status === "liquidatable" ? "danger" : "gold"}
                      >
                        {loan.status}
                      </Badge>
                    </td>
                    <td>
                      <div className="btn-row">
                        {loan.status !== "repaid" && (
                          <button className="btn btn-ghost" type="button" onClick={() => void repay(loan.id)}>
                            Repay
                          </button>
                        )}
                        {loan.status === "liquidatable" && (
                          <button className="btn btn-ghost" type="button" onClick={() => void liquidate(loan.id)}>
                            Liquidate
                          </button>
                        )}
                      </div>
                    </td>
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
