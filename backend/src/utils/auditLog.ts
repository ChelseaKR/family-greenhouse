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
  | 'household.created'
  | 'household.member_added'
  | 'household.member_removed'
  | 'household.role_changed'
  | 'household.settings_changed'
  | 'billing.subscription_changed'
  | 'billing.upgrade_requested'
  | 'billing.identify_top_up_granted'
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
