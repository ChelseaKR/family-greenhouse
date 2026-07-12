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
  | 'billing.subscription_changed'
  | 'apikey.created'
  | 'apikey.revoked'
  | 'api.task_completed'
  | 'api.task_snoozed'
  | 'plant.deleted'
  | 'rate_limit.tripped'
  | 'chat.message_sent'
  | 'chat.tools_called'
  | 'chat.response_reported';

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
