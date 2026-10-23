import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TxResult } from "../components/TxResult";
import { Bar, Badge, ErrorBox, Field, Panel, Stat } from "../components/ui";
import { api, type BroadcastResult, type ChainCycles, type ChainFleet } from "../lib/api";
import { chainLabel, percent, rawToHuman, rawToUsd, usd } from "../lib/format";

export function TreasuryPage() {
  const queryClient = useQueryClient();
  const [result, setResult] = useState<BroadcastResult | null>(null);
  const [error, setError] = useState<unknown>(null);

  const fleetQuery = useQuery({ queryKey: ["fleet"], queryFn: () => api.get<ChainFleet>("/api/chains") });
  const cyclesQuery = useQuery({
    queryKey: ["cycles"],
    queryFn: () => api.get<ChainCycles[]>("/api/treasury/cycles"),
    refetchInterval: (query) => (query.state.data?.some((c) => c.latestCycle?.status === "running") ? 4000 : 15000),
  });

  const chains = cyclesQuery.data ?? [];
  const readyChains = (fleetQuery.data?.chains ?? []).filter((c) => c.status === "ready");

  const [mintChain, setMintChain] = useState("");
  const [mintAmount, setMintAmount] = useState("100000");
  const [mintWalletId, setMintWalletId] = useState("");

  const [burnChain, setBurnChain] = useState("");
  const [burnWalletId, setBurnWalletId] = useState("");
  const [burnAmount, setBurnAmount] = useState("1000");

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["cycles"] });
    await queryClient.invalidateQueries({ queryKey: ["fleet"] });
    await queryClient.invalidateQueries({ queryKey: ["transactions"] });
  };

  const run = async (fn: () => Promise<BroadcastResult>) => {
    setError(null);
    setResult(null);
    try {
      const broadcast = await fn();
      setResult(broadcast);
      await invalidate();
    } catch (err) {
      setError(err);
    }
  };

  const mint = useMutation({
    mutationFn: () =>
      api.post<BroadcastResult>("/api/treasury/mint", {
        chain: mintChain,
        amountHuman: mintAmount,
        ...(mintWalletId ? { toWalletId: mintWalletId } : {}),
      }),
  });

  const burn = useMutation({
    mutationFn: () =>
      api.post<BroadcastResult>("/api/treasury/burn", {
        chain: burnChain,
        walletId: burnWalletId,
        amountHuman: burnAmount,
      }),
  });

  const refill = useMutation({
    mutationFn: (chain: string) => api.post<unknown>("/api/treasury/refill", { chain }),
  });

  const chainOptions = readyChains.length > 0 ? readyChains : [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Treasury vault</h1>
          <p className="page-sub">
            Each chain runs an autonomous mint cycle that credits ${(10_000_000).toLocaleString()} of wUSDT into the
            vault, then pushes {percent(chains[0]?.distributionBps ?? 2500)} out to the app wallets. Minting is gated on
            the supply invariant <span className="mono">wUSDT.totalSupply() ≤ custodied USDT</span>, read from chain at
            cycle time.
          </p>
        </div>
        <Badge kind={fleetQuery.data?.mode === "devnet" ? "gold" : "neutral"}>
          {fleetQuery.data?.mode === "devnet"
            ? "local devnet chains"
            : fleetQuery.data?.mode === "live"
              ? "live mainnet chains"
              : "connecting…"}
        </Badge>
      </div>

      <div className="grid">
        {chains.map((chain) => (
          <Panel key={chain.chain} title={chainLabel(chain.chain)} hint={`cycle target ${usd(chain.targetUsd, 0)} · ${chain.mode}`}>
            <div className="btn-row" style={{ marginBottom: 10 }}>
              <Badge kind={chain.latestCycle?.status === "completed" ? "success" : chain.latestCycle ? "gold" : "neutral"}>
                {chain.latestCycle ? `cycle #${chain.latestCycle.cycleIndex} ${chain.latestCycle.status}` : "no cycle yet"}
              </Badge>
              <Badge kind="neutral">{chain.cycles} cycle{chain.cycles === 1 ? "" : "s"}</Badge>
            </div>

            <Stat label="minted this cycle" value={`${rawToHuman(chain.latestCycle?.mintedRaw, chain.decimals, 2)} wUSDT`} small />
            <Stat
              label="distributed to app wallets"
              value={`${rawToHuman(chain.latestCycle?.distributedRaw, chain.decimals, 2)} wUSDT`}
              small
            />
            <Stat label="minted all-time" value={`${rawToHuman(chain.mintedTotalRaw, chain.decimals, 2)} wUSDT`} small />

            <div style={{ marginTop: 10 }}>
              <div className="muted" style={{ fontSize: 12 }}>
                target utilisation · {percent(chain.utilizationBps)} of {usd(chain.targetUsd, 0)}
              </div>
              <Bar bps={chain.utilizationBps} />
            </div>

            {chain.latestCycle?.error && <ErrorBox error={chain.latestCycle.error} />}

            <div className="btn-row" style={{ marginTop: 12 }}>
              <button
                className="btn btn-ghost"
                type="button"
                disabled={refill.isPending}
                onClick={() => {
                  void run(async () => {
                    await refill.mutateAsync(chain.chain);
                    return null as unknown as BroadcastResult;
                  });
                }}
              >
                Run refill cycle
              </button>
            </div>
          </Panel>
        ))}

        {chains.length === 0 && (
          <Panel title={cyclesQuery.isSuccess ? "Waiting for chains" : "Loading chains"}>
            <p className="panel-hint">
              {cyclesQuery.isSuccess
                ? "No chain deployment recorded yet. The platform is bringing the chains up and will run the first mint cycle as soon as one answers."
                : "Reading the chain fleet and mint cycles…"}
            </p>
          </Panel>
        )}
      </div>

      <div className="grid" style={{ marginTop: 18 }}>
        <Panel title="Mint engine" hint="Same reserve gate as the automatic cycle: capacity is the un-minted attested custody.">
          <Field label="Chain">
            <select value={mintChain} onChange={(e) => setMintChain(e.target.value)}>
              <option value="">Select a chain…</option>
              {chainOptions.map((chain) => (
                <option key={chain.chain} value={chain.chain}>
                  {chain.label} · capacity {rawToUsd(chain.reserve.capacityRaw, chain.wusdtDecimals)} USDT
                </option>
              ))}
            </select>
          </Field>
          <Field label="Amount (wUSDT)">
            <input value={mintAmount} onChange={(e) => setMintAmount(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Destination wallet">
            <select value={mintWalletId} onChange={(e) => setMintWalletId(e.target.value)}>
              <option value="">Treasury vault (default)</option>
              {chainOptions
                .find((c) => c.chain === mintChain)
                ?.wallets.map((wallet) => (
                  <option key={wallet.id} value={wallet.id}>
                    {wallet.label}
                  </option>
                ))}
            </select>
          </Field>
          <button
            className="btn btn-primary"
            type="button"
            disabled={!mintChain || !mintAmount || mint.isPending}
            onClick={() =>
              void run(async () => api.post<BroadcastResult>("/api/treasury/mint", {
                chain: mintChain,
                amountHuman: mintAmount,
                ...(mintWalletId ? { toWalletId: mintWalletId } : {}),
              }))
            }
          >
            Mint wUSDT
          </button>
        </Panel>

        <Panel title="Burn engine" hint="Burns wUSDT out of a platform wallet — supply down, custody unchanged.">
          <Field label="Chain">
            <select
              value={burnChain}
              onChange={(e) => {
                setBurnChain(e.target.value);
                setBurnWalletId("");
              }}
            >
              <option value="">Select a chain…</option>
              {chainOptions.map((chain) => (
                <option key={chain.chain} value={chain.chain}>
                  {chain.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Wallet to burn from">
            <select value={burnWalletId} onChange={(e) => setBurnWalletId(e.target.value)}>
              <option value="">Select a wallet…</option>
              {chainOptions
                .find((c) => c.chain === burnChain)
                ?.wallets.map((wallet) => (
                  <option key={wallet.id} value={wallet.id}>
                    {wallet.label} —{" "}
                    {wallet.balances.find((b) => b.symbol === "wUSDT")?.availableHuman ?? "0"} wUSDT
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Amount (wUSDT)">
            <input value={burnAmount} onChange={(e) => setBurnAmount(e.target.value)} inputMode="decimal" />
          </Field>
          <button
            className="btn btn-primary"
            type="button"
            disabled={!burnChain || !burnWalletId || !burnAmount || burn.isPending}
            onClick={() =>
              void run(() =>
                api.post<BroadcastResult>("/api/treasury/burn", {
                  chain: burnChain,
                  walletId: burnWalletId,
                  amountHuman: burnAmount,
                }),
              )
            }
          >
            Burn wUSDT
          </button>
        </Panel>
      </div>

      <div style={{ marginTop: 18 }}>
        <Panel title="Broadcast result" hint="The hash below came back from the node; status advances on its own.">
          {result ? <TxResult result={result} /> : <p className="muted" style={{ margin: 0, fontSize: 13 }}>No action broadcast yet.</p>}
          <ErrorBox error={error ?? mint.error ?? burn.error ?? refill.error} />
        </Panel>
      </div>
    </>
  );
}
