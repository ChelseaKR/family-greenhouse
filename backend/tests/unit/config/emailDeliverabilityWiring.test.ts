/**
 * Deployment wiring for outbound-mail deliverability (ADR 0022).
 *
 * Every item here is a piece of infrastructure whose ABSENCE is silent. A
 * missing MAIL FROM record still sends mail (just unaligned); a missing
 * configuration set still sends mail (just with no feedback); an unsubscribed
 * topic still receives events (into nothing). None of those produce an error
 * anywhere, which is exactly why they are asserted in code rather than left to
 * a reviewer noticing a deleted block.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const repositoryRoot = new URL('../../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, repositoryRoot), 'utf8');

describe('email deliverability deployment wiring', () => {
  const emailModule = read('infrastructure/modules/email/main.tf');
  const emailEvents = read('infrastructure/modules/email/events.tf');
  const emailOutputs = read('infrastructure/modules/email/outputs.tf');
  const cognitoMessages = read('infrastructure/modules/email/cognito_messages.tf');
  const authModule = read('infrastructure/modules/auth/main.tf');
  const apiModule = read('infrastructure/modules/api/main.tf');
  const terraformRoot = read('infrastructure/main.tf');
  const stagingWorkflow = read('.github/workflows/cd-staging.yml');
  const productionWorkflow = read('.github/workflows/cd-production.yml');
  const manualDeploy = read('scripts/deploy.sh');

  it('gives the domain a custom MAIL FROM subdomain with its MX and SPF records', () => {
    expect(emailModule).toMatch(/resource "aws_ses_domain_mail_from" "main"/);
    // UseDefaultValue, not RejectMessage: a DNS lag must degrade to today's
    // unaligned Return-Path, never to a total mail outage.
    expect(emailModule).toMatch(/behavior_on_mx_failure\s*=\s*"UseDefaultValue"/);
    expect(emailModule).toMatch(/feedback-smtp\./);
    expect(emailModule).toMatch(/resource "aws_route53_record" "mail_from_spf"/);
    // The MAIL FROM MX is scoped to the subdomain. The apex inbound MX
    // (support@, security@ ...) is a DIFFERENT record with a different target
    // and must survive untouched; losing it black-holes every reply.
    expect(emailModule).toMatch(/name\s*=\s*local\.mail_from_domain/);
    const inbound = read('infrastructure/modules/email/inbound.tf');
    expect(inbound).toMatch(/records\s*=\s*\["10 inbound-smtp\./);
    expect(inbound).toMatch(/name\s*=\s*var\.domain_name/);
  });

  it('publishes bounce, complaint and delivery events to SNS via a configuration set', () => {
    expect(emailEvents).toMatch(/resource "aws_sesv2_configuration_set" "main"/);
    expect(emailEvents).toMatch(/resource "aws_sesv2_configuration_set_event_destination" "sns"/);
    for (const eventType of ['BOUNCE', 'COMPLAINT', 'DELIVERY']) {
      expect(emailEvents).toContain(`"${eventType}"`);
    }
    // SES must be the only publisher, and only from this account.
    expect(emailEvents).toMatch(/identifiers\s*=\s*\["ses\.amazonaws\.com"\]/);
    expect(emailEvents).toContain('AWS:SourceAccount');
  });

  it('subscribes the emailEvents Lambda to that topic and lets SNS invoke it', () => {
    expect(apiModule).toMatch(/"emailEvents"\s*=\s*"emailEvents"/);
    expect(apiModule).toMatch(/resource "aws_sns_topic_subscription" "email_events"/);
    expect(apiModule).toMatch(/resource "aws_lambda_permission" "email_events_sns"/);
    expect(apiModule).toMatch(/principal\s*=\s*"sns\.amazonaws\.com"/);
    expect(terraformRoot).toMatch(/ses_event_topic_arn\s*=.*module\.email\[0\]\.event_topic_arn/);
    expect(emailOutputs).toMatch(/output "event_topic_arn"/);
  });

  it('reaches the send path with the configuration set and a real Reply-To', () => {
    expect(apiModule).toMatch(/SES_CONFIGURATION_SET\s*=\s*var\.ses_configuration_set/);
    expect(apiModule).toMatch(/SES_REPLY_TO\s*=\s*var\.ses_reply_to_email/);
    expect(terraformRoot).toMatch(
      /ses_configuration_set\s*=.*module\.email\[0\]\.configuration_set_name/
    );
    expect(terraformRoot).toMatch(/ses_reply_to_email\s*=\s*var\.email_reply_to/);
  });

  it('deploys the emailEvents bundle everywhere the other handlers are deployed', () => {
    for (const surface of [stagingWorkflow, productionWorkflow]) {
      expect(surface).toMatch(/for handler in [^\n]*\bemailEvents\b[^\n]*; do/);
    }
    expect(manualDeploy).toMatch(/HANDLERS=\([^)]*\bemailEvents\b[^)]*\)/);
  });

  it('brands the Cognito paths a declarative template cannot reach', () => {
    expect(cognitoMessages).toMatch(/resource "aws_lambda_function" "cognito_messages"/);
    expect(authModule).toMatch(/custom_message\s*=\s*lambda_config\.value/);
    expect(authModule).toMatch(/resource "aws_lambda_permission" "cognito_custom_message"/);
    expect(authModule).toMatch(/principal\s*=\s*"cognito-idp\.amazonaws\.com"/);
    // The dormant admin-invite path gets a declarative template too, so
    // flipping public_registration_enabled cannot ship AWS's stock copy.
    expect(authModule).toMatch(/invite_message_template/);
    expect(authModule).toContain('{username}');
    expect(terraformRoot).toMatch(
      /custom_message_lambda_arn\s*=.*module\.email\[0\]\.cognito_custom_message_lambda_arn/
    );
  });
});
