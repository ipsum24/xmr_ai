import { Interface, type InterfaceAbi } from "ethers";
import { CHAIN_REGISTRY, type ChainName } from "../../../src/shared";
import { type CompiledContract } from "./fleet";

export interface VerifyResult { ok: boolean; status: string; guid?: string; url: string }
type ExplorerReply = { status?: string; result?: string };
const API = "https://api.etherscan.io/v2/api";

/** Source publication is reported separately from the gating on-chain invariants. */
export async function verifyContract(options: {
  chain: ChainName; contract: "WrappedUSDT" | "TreasuryVault"; address: string;
  artifact: CompiledContract; args: unknown[]; key: string;
}): Promise<VerifyResult> {
  const { chain, contract, address, artifact, args, key } = options;
  const url = `${CHAIN_REGISTRY[chain].explorerBase}/address/${address}#code`;
  if (!key) return { ok: false, status: "manual-queued: explorer API key not configured", url };
  const base = { chainid: String(CHAIN_REGISTRY[chain].chainId), module: "contract", apikey: key };
  const request = async (action: string, extra: Record<string, string> = {}): Promise<ExplorerReply> => {
    const response = await fetch(API, { method: "POST", body: new URLSearchParams({ ...base, action, ...extra }), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("Explorer HTTP failure");
    return await response.json() as ExplorerReply;
  };
  let guid: string | undefined;
  try {
    const existing = await request("getabi", { address });
    if (existing.status === "1") return { ok: true, status: "already-verified", url };
    const submit = await request("verifysourcecode", {
      codeformat: "solidity-standard-json-input", contractaddress: address,
      contractname: `${contract}.sol:${contract}`, sourceCode: JSON.stringify(artifact.standardInput),
      compilerversion: artifact.compilerVersion,
      constructorArguments: new Interface(artifact.abi as InterfaceAbi).encodeDeploy(args).slice(2),
    });
    if (submit.status !== "1" || !submit.result || !/^[a-zA-Z0-9-]+$/.test(submit.result)) {
      return { ok: false, status: "manual-queued: explorer rejected source submission", url };
    }
    guid = submit.result;
    for (let attempt = 0; attempt < 18; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      const poll = await request("checkverifystatus", { guid });
      if (poll.status === "1") return { ok: true, status: "verified", guid, url };
      if (!/pending|queue/i.test(poll.result ?? "")) return { ok: false, status: "manual-queued: explorer verification failed", guid, url };
    }
    return { ok: false, status: "manual-queued: explorer verification timeout", guid, url };
  } catch { return { ok: false, status: "manual-queued: explorer unavailable", guid, url }; }
}
