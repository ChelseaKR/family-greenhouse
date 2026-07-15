import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  COMMERCIAL_HOLD_ACTIVE,
  COMMERCIAL_HOLD_EFFECTIVE_DATE,
  isPublicRegistrationAllowed,
  isPaymentActivityAllowed,
  paymentsAreAvailable,
  publicRegistrationIsAvailable,
} from '../../../src/config/commercialStatus.js';

describe('repository commercial status', () => {
  it('is active, dated, and keeps deployed payment activity unavailable', () => {
    expect(COMMERCIAL_HOLD_ACTIVE).toBe(true);
    expect(COMMERCIAL_HOLD_EFFECTIVE_DATE).toBe('2026-07-14');
    expect(paymentsAreAvailable()).toBe(false);
    expect(publicRegistrationIsAvailable()).toBe(false);
  });

  it.each([undefined, '', '0', 'true', 'TRUE', 'yes', '01', ' 1', '1 ', '\n1'])(
    'rejects a missing or non-exact runtime enablement value: %s',
    (value) => {
      expect(isPaymentActivityAllowed(false, value)).toBe(false);
      expect(isPaymentActivityAllowed(true, value)).toBe(false);
    }
  );

  it('requires both an inactive hold and the exact string 1', () => {
    expect(isPaymentActivityAllowed(true, '1')).toBe(false);
    expect(isPaymentActivityAllowed(false, '1')).toBe(true);
  });

  it.each([undefined, null, true, '', 'false', '0', 0, 1, {}, []])(
    'keeps public registration closed for any value except boolean false: %s',
    (value) => {
      expect(isPublicRegistrationAllowed(value)).toBe(false);
    }
  );

  it('allows registration eligibility only for an explicit boolean false', () => {
    expect(isPublicRegistrationAllowed(false)).toBe(true);
  });
});

describe('production IaC commercial-hold invariants', () => {
  const root = new URL('../../../../', import.meta.url);
  const apiModule = readFileSync(new URL('infrastructure/modules/api/main.tf', root), 'utf8');
  const authModule = readFileSync(new URL('infrastructure/modules/auth/main.tf', root), 'utf8');
  const productionVars = readFileSync(
    new URL('infrastructure/environments/production/terraform.tfvars', root),
    'utf8'
  );
  const productionWorkflow = readFileSync(
    new URL('.github/workflows/cd-production.yml', root),
    'utf8'
  );

  it('does not wire PAYMENTS_ENABLED into any Lambda environment', () => {
    expect(apiModule).not.toMatch(/\bPAYMENTS_ENABLED\b/);
  });

  it('keeps every committed production Stripe price id blank and the live gate false', () => {
    const priceLines = productionVars
      .split('\n')
      .filter((line) => /^stripe_price_id_[a-z_]+\s*=/.test(line.trim()));

    expect(priceLines).toHaveLength(5);
    for (const line of priceLines) {
      expect(line).toMatch(/^stripe_price_id_[a-z_]+\s*=\s*""\s*$/);
    }
    expect(productionVars).toMatch(/^stripe_price_ids_are_live\s*=\s*false\s*$/m);
  });

  it('keeps Cognito public self-signup disabled with a literal admin-only policy', () => {
    expect(authModule.match(/allow_admin_create_user_only\s*=\s*true/g)).toHaveLength(1);
    expect(authModule).not.toMatch(/allow_admin_create_user_only\s*=\s*(?:false|var\.|local\.)/);
  });

  it('deploys the compatibility frontend before the status-bearing backend API', () => {
    const deployBackend = productionWorkflow.slice(
      productionWorkflow.indexOf('  deploy-backend:'),
      productionWorkflow.indexOf('  smoke-tests:')
    );
    expect(deployBackend).toMatch(/needs:\s*\[[^\]]*deploy-frontend[^\]]*\]/);
  });
});
