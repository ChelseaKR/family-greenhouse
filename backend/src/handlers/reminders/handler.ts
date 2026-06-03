/**
 * EventBridge-invoked hourly reminder scan across every household.
 *
 * This is NOT an HTTP route — the scheduler invokes the Lambda's `handler`
 * directly with a scheduled event, so there's no API Gateway route, no auth
 * middleware, and no request parsing. It simply runs the fan-out and returns a
 * small summary (surfaced in CloudWatch logs / the invocation result).
 *
 * Wiring: `infrastructure/modules/api/main.tf` defines the Lambda (via the
 * `lambda_handlers` map) and the `aws_cloudwatch_event_rule` that triggers it.
 */
import { remindAllHouseholds } from '../../services/reminders.js';

export const handler = (): Promise<{ households: number; sent: number }> => remindAllHouseholds();
