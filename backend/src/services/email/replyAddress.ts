/**
 * The per-message reply address on a reminder email (#667, ADR 0031). Pure —
 * no DynamoDB, no AWS SDK; the environment is read only through `replyConfig`.
 *
 * A reminder that can be answered by mail carries
 *
 *   Reply-To: care+<token>@<domain>
 *
 * where `<token>` is 160 bits from the CSPRNG, written as 40 lowercase hex
 * characters. The token is the ONLY thing that ties an inbound reply to a
 * member, a household and a list of tasks: the row it names is keyed by its
 * scrypt digest (`utils/tokenHash.ts`, surface `emailReply`), and nothing
 * stored can reproduce it.
 *
 * ## Why hex, and why this local part
 *
 *   - Hex, not base64url: an address's local part is case-sensitive on paper
 *     and case-folded by real mail systems often enough that a mixed-case
 *     token would sometimes arrive as a different token. Hex survives
 *     lower-casing unchanged, so parsing lower-cases first and loses nothing.
 *   - `care+…`: SES matches a receipt-rule recipient of `care@<domain>`
 *     against every `care+<label>@<domain>` (the "labels" row of the SES
 *     recipient-condition table), so one rule serves every token without a new
 *     MX record or a subdomain. `care@` is not one of the forwarded mailboxes
 *     (`inbound.tf`), so no reply can ever reach the maintainer's inbox by
 *     accident, and no forwarded mailbox can reach this path.
 *   - 40 characters keeps `care+<token>` at 45, inside RFC 5321's 64-octet
 *     local-part limit with room to spare.
 */
import { randomBytes } from 'node:crypto';

export const REPLY_LOCAL_PART = 'care';

/** 20 bytes = 160 bits. `utils/tokenHash.ts` requires >= 128 for its fixed salt. */
const TOKEN_BYTES = 20;

const TOKEN_PATTERN = /^[0-9a-f]{40}$/;

/** A bare hostname: letters, digits, dots and hyphens, with a dotted TLD. */
const DOMAIN_PATTERN =
  /^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

export function newReplyToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

export function isReplyToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

/** The Reply-To address for one minted token. */
export function replyAddress(token: string, domain: string): string {
  if (!isReplyToken(token)) throw new Error('reply_address.invalid_token');
  return `${REPLY_LOCAL_PART}+${token}@${domain}`;
}

/**
 * Recover the token from one envelope recipient, or null.
 *
 * Deliberately strict: the whole address must be exactly
 * `care+<40 hex>@<our domain>`. Anything else — another mailbox, a second
 * label, a token of the wrong length, a look-alike domain — is not a reply
 * address, and the caller drops it without answering (answering an address we
 * did not issue is how a receiving service turns into a backscatter source).
 */
export function tokenFromRecipient(recipient: string, domain: string): string | null {
  if (typeof recipient !== 'string' || recipient.length > 320) return null;
  const address = recipient.trim().toLowerCase();
  const at = address.lastIndexOf('@');
  if (at <= 0) return null;
  if (address.slice(at + 1) !== domain.toLowerCase()) return null;
  const local = address.slice(0, at);
  const prefix = `${REPLY_LOCAL_PART}+`;
  if (!local.startsWith(prefix)) return null;
  const token = local.slice(prefix.length);
  return isReplyToken(token) ? token : null;
}

export type ReplyConfig = { enabled: true; domain: string } | { enabled: false };

/**
 * Whether reminders may carry a reply address.
 *
 * OFF unless BOTH variables are set, and set sanely. The two halves of this
 * feature ship separately — the code with a deploy, the SES receipt rule with
 * a `terraform apply` of `email_reply_actions_enabled = true` — and a reply
 * address minted before the rule exists would send every reply to a mailbox
 * nothing reads. Today those replies reach `support@`; until the owner turns
 * the rule on, that is what keeps happening.
 */
export function replyConfig(env: NodeJS.ProcessEnv = process.env): ReplyConfig {
  if (env.EMAIL_REPLY_ACTIONS_ENABLED?.trim() !== 'true') return { enabled: false };
  const domain = env.EMAIL_REPLY_DOMAIN?.trim().toLowerCase() ?? '';
  if (!DOMAIN_PATTERN.test(domain)) return { enabled: false };
  return { enabled: true, domain };
}

/**
 * The receiving side's domain. Separate from `replyConfig` on purpose: the
 * inbound Lambda must keep resolving tokens it already issued even while new
 * minting is switched off, so it needs the domain but not the flag.
 */
export function replyDomain(env: NodeJS.ProcessEnv = process.env): string | null {
  const domain = env.EMAIL_REPLY_DOMAIN?.trim().toLowerCase() ?? '';
  return DOMAIN_PATTERN.test(domain) ? domain : null;
}
