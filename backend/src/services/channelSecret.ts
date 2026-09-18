/**
 * Seal and open a household chat-channel webhook address with KMS (#674,
 * ADR 0031).
 *
 * Every other credential in this product is something the server only has to
 * RECOGNISE — a sitter link, a kiosk token, an API key — so they are stored as
 * scrypt hashes and a database leak yields nothing presentable. A webhook
 * address is the first secret the server has to REPLAY: it must be read back
 * in full on every post. It is therefore encrypted, not hashed, and the key
 * never leaves KMS:
 *
 *   - `Encrypt` / `Decrypt` directly against a customer-managed key. The
 *     address is far under KMS's 4 KB plaintext limit, so there is no data key
 *     to generate, cache or leak, and the application never holds key material
 *     at all.
 *   - The ciphertext is bound to its household by ENCRYPTION CONTEXT
 *     (`householdId` + a fixed `purpose`). A sealed address copied onto another
 *     household's row does not decrypt, and the IAM grant is conditioned on the
 *     `purpose`, so this key cannot be used to decrypt anything else.
 *   - `Decrypt` names the key it expects, so a ciphertext produced under any
 *     other key is refused rather than transparently opened.
 *
 * No key configured means no feature: `sealWebhookUrl` throws
 * `ChannelSealingUnavailableError` and the route answers 503. There is no
 * plaintext fallback and no application-held key, deliberately — the triage on
 * #674 recorded that either would be a worse answer than not shipping.
 */
import { KMSClient, EncryptCommand, DecryptCommand } from '@aws-sdk/client-kms';
import AWSXRay from 'aws-xray-sdk-core';

const PURPOSE = 'household-channel-webhook';

let client: KMSClient | null = null;
function kms(): KMSClient {
  client ??= AWSXRay.captureAWSv3Client(
    new KMSClient({ region: process.env.AWS_REGION || 'us-east-1' })
  );
  return client;
}

export class ChannelSealingUnavailableError extends Error {
  constructor() {
    super('channel webhook sealing is not configured in this environment');
    this.name = 'ChannelSealingUnavailableError';
  }
}

function keyId(): string | null {
  const value = process.env.CHANNEL_WEBHOOK_KMS_KEY_ID?.trim();
  return value ? value : null;
}

/** Whether this environment can store a webhook at all. */
export function channelSealingConfigured(): boolean {
  return keyId() !== null;
}

function encryptionContext(householdId: string): Record<string, string> {
  return { purpose: PURPOSE, householdId };
}

/** Encrypt one address for one household. Returns base64 ciphertext. */
export async function sealWebhookUrl(householdId: string, url: string): Promise<string> {
  const KeyId = keyId();
  if (!KeyId) throw new ChannelSealingUnavailableError();
  const result = await kms().send(
    new EncryptCommand({
      KeyId,
      Plaintext: Buffer.from(url, 'utf8'),
      EncryptionContext: encryptionContext(householdId),
    })
  );
  if (!result.CiphertextBlob) throw new Error('KMS returned no ciphertext');
  return Buffer.from(result.CiphertextBlob).toString('base64');
}

/** Decrypt a sealed address. Throws on any failure; callers treat that as a
 *  failed delivery attempt, never as "no channel". */
export async function openWebhookUrl(householdId: string, sealed: string): Promise<string> {
  const KeyId = keyId();
  if (!KeyId) throw new ChannelSealingUnavailableError();
  const result = await kms().send(
    new DecryptCommand({
      KeyId,
      CiphertextBlob: Buffer.from(sealed, 'base64'),
      EncryptionContext: encryptionContext(householdId),
    })
  );
  if (!result.Plaintext) throw new Error('KMS returned no plaintext');
  return Buffer.from(result.Plaintext).toString('utf8');
}

/** Test seam: drop the memoised client so a mocked constructor is used. */
export function __resetChannelSecretClientForTests(): void {
  client = null;
}
