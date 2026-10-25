import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPublicKey } from "node:crypto";
import { getBytes, keccak256, Signature, Transaction, Wallet } from "ethers";
import type { KMSClient } from "@aws-sdk/client-kms";
import { assertLaunchMode, safeFailure, SecretsResolver } from "./lib/secrets-resolver";
import { assertFee, assertFreshBlock, resolveEndpoints } from "./lib/deployment-network";
import { DeploymentJournal, sha256 } from "./lib/deployment-journal";
import { decodeKmsSignature, KmsSigner } from "./lib/kms-signer";
import { verifyContract } from "./lib/verify-contract";
import { compileVault, compileWusdt } from "./lib/fleet";
import { DeploymentSteps, retryNetwork } from "./lib/deployment-steps";
import type { DeploymentNetwork } from "./lib/deployment-network";

// These are ephemeral, test-only signing keys, never mainnet credentials.
const wallet = Wallet.createRandom();
const toDer = (r: string, s: string): Uint8Array => {
  const integer = (hex: string): Buffer => {
    let bytes = Buffer.from(hex.slice(2).replace(/^(00)+/, ""), "hex");
    if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
    return Buffer.concat([Buffer.from([2, bytes.length]), bytes]);
  };
  const body = Buffer.concat([integer(r), integer(s)]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
};

test("launch refuses development, raw custody keys and mock switches", () => {
  assert.throws(() => assertLaunchMode({ CHAIN_MODE: "devnet", NODE_ENV: "production" }));
  assert.throws(() => assertLaunchMode({ CHAIN_MODE: "live", NODE_ENV: "production", LIVE_SIGNER_PRIVATE_KEY: "test-only" }));
  assert.throws(() => assertLaunchMode({ CHAIN_MODE: "live", NODE_ENV: "production", MOCK_ENABLED: "false" }));
  assert.doesNotThrow(() => assertLaunchMode({ CHAIN_MODE: "live", NODE_ENV: "production" }));
});

test("secret precedence and endpoint validation do not disclose provider credentials", async () => {
  const resolver = new SecretsResolver({ ETH_RPC: "https://provider.invalid/secret-path", ETH_RPC_2: "https://backup.invalid/key", SECRETS_PROVIDER: "env" });
  try {
    assert.equal(await resolver.get("ETH_RPC"), "https://provider.invalid/secret-path");
    assert.equal((await resolveEndpoints("ethereum", resolver)).length, 2);
    assert.equal(await resolver.get("MISSING"), "");
    await assert.rejects(resolver.require("MISSING"), /MISSING/);
    const bad = new SecretsResolver({ ETH_RPC: "http://localhost:8545/private-key" });
    try { await assert.rejects(resolveEndpoints("ethereum", bad), (error: Error) => !error.message.includes("private-key")); }
    finally { bad.destroy(); }
    assert.ok(!safeFailure(new Error("https://secret.invalid/token")).includes("secret.invalid"));
  } finally { resolver.destroy(); }
});

test("head and fee guards fail on stale, future, missing and spiking values", () => {
  assert.doesNotThrow(() => assertFreshBlock(1_000, 1_010_000));
  assert.throws(() => assertFreshBlock(1_000, 1_400_000));
  assert.throws(() => assertFreshBlock(2_000, 1_000_000));
  assert.doesNotThrow(() => assertFee(200n, 100n));
  assert.throws(() => assertFee(201n, 100n));
  assert.throws(() => assertFee(0n, 100n));
  assert.throws(() => assertFee(2_000_000_000n, 2_000_000_000n, "1"));
});

test("journal survives a restart, locks concurrent launchers and detects tampering", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wusdt-journal-"));
  const raw = await wallet.signTransaction({ to: wallet.address, nonce: 0, chainId: 1, gasLimit: 21_000, gasPrice: 1 });
  const fingerprint = sha256("test-source");
  try {
    const first = new DeploymentJournal(directory, fingerprint);
    assert.throws(() => new DeploymentJournal(directory, fingerprint), /locked/);
    first.chain("ethereum").steps.deploy = { raw, hash: keccak256(raw) };
    first.save();
    first.close();
    const second = new DeploymentJournal(directory, fingerprint);
    assert.equal(second.chain("ethereum").steps.deploy.raw, raw);
    second.receipt([{ chain: "ethereum", hash: keccak256(raw) }], [{ chain: "bsc", error: "test failure" }]);
    const receipt = JSON.parse(fs.readFileSync(path.join(directory, "deployment_receipt.json"), "utf8"));
    const { sha256: digest, ...body } = receipt;
    assert.equal(digest, sha256(JSON.stringify(body)));
    assert.equal(body.status, "partial");
    second.close();
    assert.throws(() => new DeploymentJournal(directory, sha256("changed-source")), /corrupt or belongs/);
    const file = path.join(directory, "journal.json");
    const changed = JSON.parse(fs.readFileSync(file, "utf8"));
    changed.chains.ethereum.steps.deploy.hash = `0x${"00".repeat(32)}`;
    fs.writeFileSync(file, JSON.stringify(changed));
    assert.throws(() => new DeploymentJournal(directory, fingerprint), /corrupt or belongs/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("KMS signer recovers the expected address and signs Ethereum transactions", async () => {
  const key = wallet.signingKey.publicKey.slice(4);
  const publicKey = createPublicKey({ key: { kty: "EC", crv: "secp256k1", x: Buffer.from(key.slice(0, 64), "hex").toString("base64url"), y: Buffer.from(key.slice(64), "hex").toString("base64url") }, format: "jwk" }).export({ type: "spki", format: "der" });
  let signatures = 0;
  const client = {
    send: async (command: { input: { Message?: Uint8Array } }) => {
      if (!command.input.Message) return { PublicKey: publicKey, KeySpec: "ECC_SECG_P256K1", KeyUsage: "SIGN_VERIFY" };
      signatures += 1;
      const signature = wallet.signingKey.sign(getBytes(command.input.Message));
      return { Signature: toDer(signature.r, signature.s) };
    },
  } as unknown as KMSClient;
  const signer = new KmsSigner("unit-test-nonexportable-key", client);
  assert.equal(await signer.getAddress(), wallet.address);
  const raw = await signer.signTransaction({ to: wallet.address, chainId: 1, nonce: 0, gasPrice: 1, gasLimit: 21_000 });
  assert.equal(Transaction.from(raw).from, wallet.address);
  assert.equal(signatures, 1);
  await assert.rejects(signer.signTransaction({ from: Wallet.createRandom().address }), /does not match/);
  assert.throws(() => decodeKmsSignature(new Uint8Array([0x30, 1, 0])));
  const signature = wallet.signingKey.sign(keccak256("0x1234"));
  assert.equal(Signature.from({ ...decodeKmsSignature(toDer(signature.r, signature.s)), yParity: signature.yParity }).r, signature.r);
});

test("transport retries are bounded and policy failures are never retried", async () => {
  let attempts = 0;
  const pauses: number[] = [];
  const value = await retryNetwork(async () => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error("offline"), { code: "NETWORK_ERROR" });
    return "recovered";
  }, async (ms) => { pauses.push(ms); });
  assert.equal(value, "recovered");
  assert.deepEqual(pauses, [1_000, 2_000]);
  let policyAttempts = 0;
  await assert.rejects(retryNetwork(async () => { policyAttempts += 1; throw new Error("policy failed"); }));
  assert.equal(policyAttempts, 1);
});

test("an ambiguous broadcast resumes the journaled signed bytes without signing again", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wusdt-broadcast-"));
  const store = new DeploymentJournal(directory, sha256("resume-test"));
  let signed = 0;
  let broadcast = 0;
  let mined = false;
  let hash = "";
  const signatory = {
    getAddress: async () => wallet.address,
    signTransaction: async (request: Parameters<typeof wallet.signTransaction>[0]) => { signed += 1; return wallet.signTransaction(request); },
  };
  const p = {
    getFeeData: async () => ({ gasPrice: 1n, maxFeePerGas: null }),
    getTransactionCount: async () => 0,
    getNetwork: async () => ({ chainId: 1n }),
    estimateGas: async () => 21_000n,
    getBalance: async () => 1_000_000_000n,
    getTransactionReceipt: async () => mined ? { status: 1, confirmations: async () => 12 } : null,
    getTransaction: async () => null,
    broadcastTransaction: async (raw: string) => {
      broadcast += 1;
      hash = keccak256(raw);
      assert.equal(store.chain("ethereum").steps.transfer.raw, raw, "intent must already be durable");
      if (broadcast === 1) throw new Error("ambiguous transport failure");
      mined = true;
      return { hash };
    },
    waitForTransaction: async () => ({ status: 1, confirmations: async () => 12 }),
  };
  try {
    const network = { chain: "ethereum", provider: p, fee: 1n, gasBudget: 100_000n } as unknown as DeploymentNetwork;
    const runner = new DeploymentSteps(network, signatory as never, store, 12, 1_000);
    const intent = { to: wallet.address, data: "0x" };
    await assert.rejects(runner.transaction("transfer", intent));
    const checkpoint = store.chain("ethereum").steps.transfer.hash;
    await runner.transaction("transfer", intent);
    assert.equal(hash, checkpoint);
    assert.equal(signed, 1);
    assert.equal(broadcast, 2);
    assert.ok(store.chain("ethereum").steps.transfer.confirmed);
  } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("explorer missing-key status is explicit and compiler input uses actual sources", async () => {
  const artifact = compileWusdt();
  assert.ok(artifact.compilerVersion.startsWith("v0.8."));
  const result = await verifyContract({ chain: "ethereum", contract: "WrappedUSDT", address: wallet.address, artifact, args: [], key: "" });
  assert.equal(result.ok, false);
  assert.match(result.status, /manual-queued/);
  assert.ok(compileVault().bytecode.length > 100);
});
