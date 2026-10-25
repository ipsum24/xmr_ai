import { createPublicKey } from "node:crypto";
import { GetPublicKeyCommand, KMSClient, SignCommand } from "@aws-sdk/client-kms";
import {
  AbstractSigner, computeAddress, getAddress, getBytes, hashMessage, recoverAddress,
  resolveProperties, Signature, Transaction, TypedDataEncoder,
  type Provider, type TransactionRequest, type TypedDataDomain, type TypedDataField,
} from "ethers";

const CURVE_ORDER = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");

/** Parse the ASN.1 ECDSA signature KMS returns, enforcing Ethereum low-s. */
export function decodeKmsSignature(der: Uint8Array): { r: string; s: string } {
  const bytes = Buffer.from(der);
  if (bytes[0] !== 0x30 || bytes[1] !== bytes.length - 2 || bytes.length > 72) throw new Error("Invalid KMS signature");
  let offset = 2;
  const integer = (): bigint => {
    if (bytes[offset++] !== 2) throw new Error("Invalid KMS signature integer");
    const size = bytes[offset++];
    if (!size || size > 33 || offset + size > bytes.length || (bytes[offset] & 0x80)) throw new Error("Invalid KMS signature length");
    const result = BigInt(`0x${bytes.subarray(offset, offset + size).toString("hex")}`);
    offset += size;
    if (result <= 0n || result >= CURVE_ORDER) throw new Error("Invalid KMS signature scalar");
    return result;
  };
  const r = integer();
  const rawS = integer();
  if (offset !== bytes.length) throw new Error("Trailing KMS signature data");
  const s = rawS > CURVE_ORDER / 2n ? CURVE_ORDER - rawS : rawS;
  return { r: `0x${r.toString(16).padStart(64, "0")}`, s: `0x${s.toString(16).padStart(64, "0")}` };
}

/** Non-exportable AWS ECC_SECG_P256K1 key. AWS IAM credentials use its SDK chain. */
export class KmsSigner extends AbstractSigner {
  private address?: string;

  constructor(private readonly keyId: string, private readonly client: KMSClient, provider: Provider | null = null) {
    super(provider);
  }

  connect(provider: Provider | null): KmsSigner {
    const signer = new KmsSigner(this.keyId, this.client, provider);
    signer.address = this.address;
    return signer;
  }

  async getAddress(): Promise<string> {
    if (!this.address) {
      const result = await this.client.send(new GetPublicKeyCommand({ KeyId: this.keyId }), { abortSignal: AbortSignal.timeout(10_000) });
      if (result.KeySpec !== "ECC_SECG_P256K1" || result.KeyUsage !== "SIGN_VERIFY" || !result.PublicKey) {
        throw new Error("KMS key must be ECC_SECG_P256K1 with SIGN_VERIFY usage");
      }
      const publicKey = createPublicKey({ key: Buffer.from(result.PublicKey), format: "der", type: "spki" }).export({ format: "jwk" });
      if (!publicKey.x || !publicKey.y) throw new Error("KMS public key is not an EC key");
      this.address = computeAddress(`0x04${Buffer.from(publicKey.x, "base64url").toString("hex")}${Buffer.from(publicKey.y, "base64url").toString("hex")}`);
    }
    return this.address;
  }

  private async signDigest(digest: string): Promise<Signature> {
    const address = await this.getAddress();
    const result = await this.client.send(new SignCommand({
      KeyId: this.keyId, Message: getBytes(digest), MessageType: "DIGEST", SigningAlgorithm: "ECDSA_SHA_256",
    }), { abortSignal: AbortSignal.timeout(10_000) });
    if (!result.Signature) throw new Error("KMS returned no signature");
    const scalars = decodeKmsSignature(result.Signature);
    for (const yParity of [0, 1] as const) {
      const signature = Signature.from({ ...scalars, yParity });
      if (recoverAddress(digest, signature) === address) return signature;
    }
    throw new Error("KMS signature does not recover the configured signer");
  }

  async signTransaction(request: TransactionRequest): Promise<string> {
    const tx = await resolveProperties(request);
    if (tx.from && getAddress(String(tx.from)) !== await this.getAddress()) throw new Error("Transaction from does not match KMS signer");
    delete tx.from;
    const transaction = Transaction.from(tx as Parameters<typeof Transaction.from>[0]);
    transaction.signature = await this.signDigest(transaction.unsignedHash);
    return transaction.serialized;
  }

  async signMessage(message: string | Uint8Array): Promise<string> {
    return (await this.signDigest(hashMessage(message))).serialized;
  }

  async signTypedData(domain: TypedDataDomain, types: Record<string, TypedDataField[]>, value: Record<string, unknown>): Promise<string> {
    return (await this.signDigest(TypedDataEncoder.hash(domain, types, value))).serialized;
  }
}
