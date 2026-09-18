import { logger } from './logger.js';

/**
 * Structured audit log for security-relevant events. Tagged with
 * `audit: true` so we can ship them to a separate sink (e.g. a long-retention
 * CloudWatch group, or a SIEM) without comingling with application logs.
 *
 * Conventions:
 *   - One log per discrete action (don't roll multiple events into one).
 *   - Always include actor identity if known.
 *   - Never include credentials, tokens, or PII beyond email + userId.
 */
export type AuditEvent =
  | 'auth.login.success'
  | 'auth.login.failure'
  | 'auth.signup'
  | 'auth.password_reset_requested'
  | 'auth.password_reset_completed'
  | 'auth.password_changed'
  | 'auth.profile_updated'
  | 'auth.account_deleted'
  // Two-step verification (#671). Setup-started is its own line because the
  // secret is issued there, before any code proves the authenticator exists;
  // enabled/disabled are the only lines that mean the factor changed. None
  // carries the secret or a code.
  | 'auth.mfa.totp_setup_started'
  | 'auth.mfa.totp_enabled'
  | 'auth.mfa.totp_disabled'
  | 'household.created'
  | 'household.member_added'
  | 'household.member_removed'
  // A member left on their own (#686); `household.member_removed` stays the
  // admin-removes-someone line, so the two are countable apart.
  | 'household.member_left'
  | 'household.role_changed'
  | 'household.settings_changed'
  | 'billing.subscription_changed'
  | 'billing.upgrade_requested'
  | 'billing.identify_top_up_granted'
  // The 14-day price-change notice (#710, services/priceChangeNotices.ts).
  // One line per admin actually emailed; never fired for a skip (already
  // notified) or a failed send, so the audit trail cannot claim a notice was
  // given when it was not.
  | 'billing.price_change_notice_sent'
  // Gift subscriptions (ADR 0028): a paid gift created with its code, and a
  // code placed on a household. Neither line carries the code.
  | 'billing.gift_subscription_granted'
  | 'billing.gift_redeemed'
  // Refer-a-friend (ADR 0029): a household's bonus is audited as part of
  // household.created; this line covers the REFERRER's side, since that
  // write happens later, against a different household, and can be skipped.
  | 'referral.signup_credited'
  // Outbound-mail deliverability (services/emailSuppression.ts). Suppressing
  // an address stops every product email to it, and clearing one puts it back
  // on the send list — both are consequential enough to leave a trail.
  | 'email.suppressed'
  | 'email.suppression_cleared'
  | 'apikey.created'
  | 'apikey.revoked'
  | 'calendar_token.created'
  | 'calendar_token.revoked'
  | 'api.task_completed'
  | 'api.task_snoozed'
  | 'plant.deleted'
  // Household trash (#670). `plant.deleted` above now means a PERMANENT
  // deletion (purge now, or the erasure path); moving into the trash and
  // coming back out are their own lines so the two are never conflated.
  | 'plant.trashed'
  | 'task.trashed'
  | 'trash.restored'
  | 'trash.purged'
  // A household restored from its own export (#669). One line per commit that
  // wrote (or tried to write) rows: `metadata.outcome` is `complete`,
  // `plan_limit` or `write_failed`, with counts and the archive digest — never
  // the file, a note, or a name from it.
  | 'archive.imported'
  | 'rate_limit.tripped'
  | 'chat.message_sent'
  | 'chat.tools_called'
  | 'chat.response_reported'
  | 'sitter.photo_uploaded'
  | 'planttag.issued'
  | 'planttag.revoked'
  // The management list hands back every active tag's RAW token in one call —
  // the only bulk read of live secrets in the API. Audited so an export is
  // visible after the fact; the metadata carries the count, never a token.
  | 'planttag.listed'
  | 'planttag.pin_changed'
  | 'planttag.task_completed';

export interface AuditFields {
  actorId?: string;
  actorEmail?: string;
  targetId?: string;
  householdId?: string;
  ip?: string;
  metadata?: Record<string, unknown>;
}

export function audit(event: AuditEvent, fields: AuditFields = {}): void {
  logger.info(
    {
      audit: true,
      event,
      ...fields,
    },
    event
  );
}
