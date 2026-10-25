import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Transaction } from "ethers";
import { LaunchError } from "./secrets-resolver";

export interface TransactionCheckpoint {
  hash: string;
  raw: string;
  confirmed?: boolean;
}
export interface ChainCheckpoint {
  steps: Record<string, TransactionCheckpoint>;
  wusdt?: string;
  vault?: string;
  verified?: boolean;
}
interface Journal {
  version: 1;
  fingerprint: string;
  chains: Record<string, ChainCheckpoint>;
}

export function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }

/** Same-directory atomic commit, durable before any transaction is broadcast. */
export function atomicJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  const directory = fs.openSync(path.dirname(file), "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

/** Single-process ownership also prevents two CLIs consuming the same nonce. */
export class DeploymentJournal {
  private readonly data: Journal;
  private readonly lock: string;

  constructor(readonly directory: string, fingerprint: string) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.lock = path.join(directory, "deploy.lock");
    try { fs.writeFileSync(this.lock, `${process.pid}\n`, { flag: "wx", mode: 0o600 }); }
    catch { throw new LaunchError("Deployment journal is locked; ensure the previous launcher stopped before removing deploy.lock"); }
    try {
      const file = path.join(directory, "journal.json");
      this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { version: 1, fingerprint, chains: {} };
      if (this.data.version !== 1 || this.data.fingerprint !== fingerprint || !this.data.chains || typeof this.data.chains !== "object") {
        throw new Error("journal identity mismatch");
      }
      for (const record of Object.values(this.data.chains)) {
        if (!record.steps || typeof record.steps !== "object") throw new Error("invalid steps");
        for (const step of Object.values(record.steps)) {
          if (Transaction.from(step.raw).hash !== step.hash) throw new Error("invalid checkpoint hash");
        }
      }
      this.save();
    } catch {
      this.close();
      throw new LaunchError("Deployment journal is corrupt or belongs to different source, signer or configuration; do not delete it to retry");
    }
  }

  chain(name: string): ChainCheckpoint {
    return this.data.chains[name] ??= { steps: {} };
  }

  save(): void { atomicJson(path.join(this.directory, "journal.json"), this.data); }
  close(): void { fs.unlinkSync(this.lock); }

  receipt(results: unknown[], failures: unknown[]): void {
    const body = { version: 1, fingerprint: this.data.fingerprint, status: failures.length ? "partial" : "complete", results, failures, at: new Date().toISOString() };
    atomicJson(path.join(this.directory, "deployment_receipt.json"), { ...body, sha256: sha256(JSON.stringify(body)) });
  }
}
