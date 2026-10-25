import {
  ContractFactory, getAddress, getCreate2Address, getCreateAddress, keccak256, Transaction,
  type InterfaceAbi, type Signer, type TransactionRequest,
} from "ethers";
import { type CompiledContract } from "./fleet";
import { DeploymentJournal } from "./deployment-journal";
import { assertFee, currentFee, type DeploymentNetwork } from "./deployment-network";
import { LaunchError } from "./secrets-resolver";

export interface Create2Config { address: string; codeHash: string; salt: string }

/** Retry transport errors only; contract reverts and policy failures are terminal. */
export async function retryNetwork<T>(operation: () => Promise<T>, pause: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      const code = (error as { code?: string }).code ?? "";
      if (attempt >= 2 || !["NETWORK_ERROR", "SERVER_ERROR", "TIMEOUT", "ECONNRESET", "ETIMEDOUT"].includes(code)) throw error;
      await pause(1_000 * 2 ** attempt);
    }
  }
}

/** Each signed intent is committed BEFORE broadcast. Retries reuse the exact bytes. */
export class DeploymentSteps {
  constructor(
    private readonly network: DeploymentNetwork,
    private readonly signer: Signer,
    private readonly journal: DeploymentJournal,
    private readonly confirmations: number,
    private readonly timeout: number,
    private readonly feeCeiling?: string,
  ) {}

  async transaction(name: string, request: TransactionRequest): Promise<Transaction> {
    return retryNetwork(() => this.executeTransaction(name, request));
  }

  private async executeTransaction(name: string, request: TransactionRequest): Promise<Transaction> {
    const { provider: p, chain } = this.network;
    const record = this.journal.chain(chain);
    const sender = await this.signer.getAddress();
    let step = record.steps[name];
    if (!step) {
      const price = await currentFee(p);
      assertFee(price, this.network.fee, this.feeCeiling);
      const nonce = await p.getTransactionCount(sender, "pending");
      const intent = { ...request, from: sender, nonce, chainId: (await p.getNetwork()).chainId, type: 0, gasPrice: price };
      const gasLimit = (await p.estimateGas(intent)) * 120n / 100n;
      const reserved = Object.values(record.steps).reduce((sum, item) => sum + Transaction.from(item.raw).gasLimit, 0n);
      if (reserved + gasLimit > this.network.gasBudget) throw new LaunchError(`${chain}: transaction estimates exceed DEPLOY_GAS_BUDGET`);
      if (await p.getBalance(sender) < (this.network.gasBudget - reserved) * price) throw new LaunchError(`${chain}: remaining deployment gas budget is not funded`);
      const raw = await this.signer.signTransaction({ ...intent, gasLimit });
      const hash = Transaction.from(raw).hash;
      if (!hash) throw new LaunchError(`${chain}: signer returned an unsigned transaction`);
      step = record.steps[name] = { hash, raw };
      this.journal.save();
    }
    const tx = Transaction.from(step.raw);
    if (tx.from !== getAddress(sender) || tx.chainId !== (await p.getNetwork()).chainId ||
      tx.data !== (request.data ?? "0x") || tx.to !== (request.to ? getAddress(String(request.to)) : null) || tx.value !== BigInt(String(request.value ?? 0))) {
      throw new LaunchError(`${chain}: checkpoint does not match the intended transaction`);
    }

    let receipt = await p.getTransactionReceipt(step.hash);
    if (!receipt && !await p.getTransaction(step.hash)) {
      assertFee(tx.gasPrice ?? tx.maxFeePerGas ?? 0n, this.network.fee, this.feeCeiling);
      // Re-broadcasting this same signed hash is nonce-safe even after an ambiguous failure.
      await p.broadcastTransaction(step.raw);
    }
    if (!receipt || await receipt.confirmations() < this.confirmations) {
      receipt = await p.waitForTransaction(step.hash, this.confirmations, this.timeout);
    }
    if (!receipt) throw new LaunchError(`${chain}: receipt confirmation timed out; retry with the same journal`);
    if (receipt.status !== 1) throw new LaunchError(`${chain}: ${name} reverted on chain; no replacement deployment was sent`);
    step.confirmed = true;
    this.journal.save();
    return tx;
  }

  async deploy(name: string, artifact: CompiledContract, args: unknown[], create2?: Create2Config): Promise<string> {
    const factory = new ContractFactory(artifact.abi as InterfaceAbi, artifact.bytecode);
    const request = await factory.getDeployTransaction(...args);
    if (create2) {
      const code = await this.network.provider.getCode(create2.address);
      if (code === "0x" || keccak256(code) !== create2.codeHash) throw new LaunchError("CREATE2 factory runtime does not match the pinned code hash");
      const address = getCreate2Address(create2.address, create2.salt, keccak256(String(request.data)));
      if (await this.network.provider.getCode(address) !== "0x" && !this.journal.chain(this.network.chain).steps[name]) return address;
      await this.transaction(name, { to: create2.address, data: `${create2.salt}${String(request.data).slice(2)}` });
      if (await this.network.provider.getCode(address) === "0x") throw new LaunchError("CREATE2 transaction did not deploy the predicted contract");
      return address;
    }
    const tx = await this.transaction(name, request);
    const address = getCreateAddress({ from: tx.from!, nonce: tx.nonce });
    if (await this.network.provider.getCode(address) === "0x") throw new LaunchError("Deployment succeeded without code at the predicted address");
    return address;
  }
}
