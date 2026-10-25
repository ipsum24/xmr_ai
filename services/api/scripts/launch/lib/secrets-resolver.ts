import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

/** Environment wins. Remote lookup is opt-in; resolved values never go to disk. */
export class SecretsResolver {
  private readonly cache = new Map<string, Promise<string>>();
  private readonly client = new SecretsManagerClient({ region: process.env.AWS_REGION, maxAttempts: 2 });

  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {
    const source = environment.SECRETS_PROVIDER;
    if (source && source !== "env" && source !== "aws") throw new Error("SECRETS_PROVIDER must be env or aws");
  }

  get(name: string): Promise<string> {
    const local = this.environment[name]?.trim();
    if (local) return Promise.resolve(local);
    if (this.environment.SECRETS_PROVIDER !== "aws") return Promise.resolve("");
    let pending = this.cache.get(name);
    if (!pending) {
      pending = this.remote(name);
      this.cache.set(name, pending);
    }
    return pending;
  }

  async require(name: string): Promise<string> {
    const value = await this.get(name);
    if (!value) throw new LaunchError(`Missing required value ${name}`);
    return value;
  }

  private async remote(name: string): Promise<string> {
    try {
      const response = await this.client.send(new GetSecretValueCommand({
        SecretId: `${this.environment.AWS_SECRET_PREFIX ?? ""}${name}`,
      }), { abortSignal: AbortSignal.timeout(10_000) });
      if (response.SecretBinary) throw new Error("SecretBinary is not supported");
      return response.SecretString?.trim() ?? "";
    } catch (error) {
      if ((error as { name?: string }).name === "ResourceNotFoundException") return "";
      // SDK errors may include credential-bearing URLs or response bodies.
      throw new Error(`Unable to resolve ${name} from AWS Secrets Manager`);
    }
  }

  destroy(): void { this.client.destroy(); }
}

/** Do not echo raw exception messages from providers, signers or HTTP clients. */
export function safeFailure(error: unknown): string {
  if (error instanceof LaunchError) return error.message;
  const code = (error as { code?: string; name?: string })?.code ?? (error as { name?: string })?.name;
  return `Operation failed${code && /^[A-Z_0-9]+$/.test(code) ? ` (${code})` : ""}; inspect the chain and retry the same journal`;
}

export class LaunchError extends Error {}

export function assertLaunchMode(environment: NodeJS.ProcessEnv = process.env): void {
  if (environment.CHAIN_MODE !== "live" || environment.NODE_ENV !== "production") {
    throw new LaunchError("Deployment requires CHAIN_MODE=live and NODE_ENV=production");
  }
  if (environment.LIVE_SIGNER_PRIVATE_KEY) {
    throw new LaunchError("Raw custody keys are refused by this launcher; use LIVE_SIGNER_KEY_ID (AWS KMS)");
  }
  const banned = ["MOCK_", "SIMULATE_", "FAKE_", "DEMO_MODE", "SEED_DEMO"];
  if (Object.keys(environment).some((key) => banned.some((prefix) => key.startsWith(prefix)))) {
    throw new LaunchError("Mock, simulate and demo switches are forbidden for deployment");
  }
}
