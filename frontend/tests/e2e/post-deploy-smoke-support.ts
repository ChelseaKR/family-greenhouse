const EMAIL_TEMPLATE_TOKEN = '{tag}';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOUSEHOLD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOUSEHOLD_MEMBERSHIP_PATTERN =
  /^HOUSEHOLD#([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * Build a unique address from an operator-configured, deliverable mailbox
 * template such as `fg-smoke+{tag}@example.com`. Requiring the placeholder
 * avoids reusing/deleting a real account, while requiring configuration keeps
 * the smoke test from inventing recipients that hard-bounce.
 */
export function buildSmokeEmail(template: string | undefined, tag: string): string {
  if (!template) {
    throw new Error(
      'E2E_PUBLIC_SIGNUP_EMAIL_TEMPLATE is required (for example, fg-smoke+{tag}@example.com)'
    );
  }
  if (template.trim() !== template) {
    throw new Error('E2E_PUBLIC_SIGNUP_EMAIL_TEMPLATE must not contain surrounding whitespace');
  }
  if (!/^[a-z0-9-]{1,48}$/i.test(tag)) {
    throw new Error('Smoke email tag must contain only 1-48 letters, numbers, or hyphens');
  }

  const tokenCount = template.split(EMAIL_TEMPLATE_TOKEN).length - 1;
  const at = template.lastIndexOf('@');
  if (tokenCount !== 1 || template.indexOf(EMAIL_TEMPLATE_TOKEN) > at) {
    throw new Error(
      'E2E_PUBLIC_SIGNUP_EMAIL_TEMPLATE must contain exactly one {tag} placeholder before @'
    );
  }

  const email = template.replace(EMAIL_TEMPLATE_TOKEN, tag);
  const [localPart] = email.split('@');
  if (!EMAIL_PATTERN.test(email) || email.length > 254 || localPart.length > 64) {
    throw new Error('E2E_PUBLIC_SIGNUP_EMAIL_TEMPLATE produced an invalid email address');
  }
  return email;
}

/** Membership rows store the household lookup key in GSI1SK, not SK. */
export function householdIdFromMembershipItem(item: Record<string, unknown>): string | null {
  const attribute = item['GSI1SK'];
  const value =
    typeof attribute === 'object' &&
    attribute !== null &&
    'S' in attribute &&
    typeof attribute.S === 'string'
      ? attribute.S
      : '';
  const match = HOUSEHOLD_MEMBERSHIP_PATTERN.exec(value);
  return match?.[1] ?? null;
}

/** Validate the authoritative id returned by POST /households. */
export function householdIdFromCreateResponse(response: unknown): string {
  const id =
    typeof response === 'object' &&
    response !== null &&
    'id' in response &&
    typeof response.id === 'string'
      ? response.id
      : '';
  if (!HOUSEHOLD_ID_PATTERN.test(id)) {
    throw new Error('POST /households did not return a valid household UUID');
  }
  return id;
}

export interface CleanupStep {
  label: string;
  run: () => Promise<void>;
}

/** Attempt every cleanup branch, then fail once with all observed errors. */
export async function runAllCleanupSteps(steps: CleanupStep[]): Promise<void> {
  const failures: Error[] = [];

  for (const step of steps) {
    try {
      await step.run();
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      failures.push(new Error(`${step.label}: ${detail}`, { cause }));
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Post-deploy smoke cleanup failed in ${failures.length} step(s): ${failures
        .map((failure) => failure.message)
        .join('; ')}`
    );
  }
}
