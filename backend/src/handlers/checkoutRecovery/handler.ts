/**
 * EventBridge-invoked abandoned-checkout recovery scan — NOT an HTTP route
 * (same contract as `handlers/reminders/handler.ts` and
 * `handlers/digests/handler.ts`: the scheduler invokes `handler` directly with
 * a scheduled event, so there's no API Gateway route, no auth middleware, and
 * no request parsing). Runs `services/checkoutRecoveryEmails.ts`'s fan-out and
 * returns a small summary, surfaced in CloudWatch logs.
 *
 * Wiring: `infrastructure/modules/api/main.tf` defines the Lambda (via the
 * `lambda_handlers` map) and the `aws_cloudwatch_event_rule` that triggers it,
 * on its own schedule — not riding the hourly `reminders` invocation, because
 * a household that abandoned a checkout should hear about it within roughly
 * the same window `PENDING_CHECKOUT_WINDOW_MS` (45 minutes) already makes it
 * wait before the marker goes stale, not up to an hour later on top of that.
 */
import {
  runCheckoutRecoveryEmails,
  type CheckoutRecoveryRunSummary,
} from '../../services/checkoutRecoveryEmails.js';
import { deadlineFrom } from '../../services/scheduledFanOut.js';

export const handler = (
  _event?: unknown,
  context?: { getRemainingTimeInMillis?: () => number }
): Promise<CheckoutRecoveryRunSummary> =>
  runCheckoutRecoveryEmails(new Date(), { deadlineAt: deadlineFrom(context) });
