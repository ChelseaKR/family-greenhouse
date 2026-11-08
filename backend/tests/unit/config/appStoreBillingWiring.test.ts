/**
 * Deployment wiring for Apple In-App Purchase (ADR 0041).
 *
 * OFF BY DEFAULT, ON IN STAGING AND PRODUCTION: both variable declarations
 * default to "0", and each environment opens it with its own reviewed tfvars
 * line. Production must be open because App Review buys with a Sandbox Apple
 * Account against the production API; with the switch off that purchase is
 * refused. Production also must not narrow APP_STORE_ENVIRONMENTS, or the
 * reviewer's Sandbox transaction would be ignored.
 *
 * Each negative control asserts its sabotage changed the text before asserting
 * the check notices, so a replacement that matched nothing cannot read as a pass.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appStoreEnvironments } from '../../../src/config/appStore.js';

const root = new URL('../../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

const apiModule = read('infrastructure/modules/api/main.tf');
const apiVariables = read('infrastructure/modules/api/variables.tf');
const rootModule = read('infrastructure/main.tf');
const rootVariables = read('infrastructure/variables.tf');
const productionTfvars = read('infrastructure/environments/production/terraform.tfvars');
const stagingTfvars = read('infrastructure/environments/staging/terraform.tfvars');
const commercialStatus = JSON.parse(read('commercial-status.json')) as {
  commercialHoldActive: boolean;
};

const variableBlock = (source: string, name: string): string => {
  const start = source.indexOf(`variable "${name}" {`);
  if (start < 0) return '';
  return source.slice(start, source.indexOf('\n}\n', start) + 3);
};

const defaultsOff = (source: string): boolean =>
  /type\s+=\s+string/.test(variableBlock(source, 'app_store_billing_enabled')) &&
  /default\s+=\s+"0"/.test(variableBlock(source, 'app_store_billing_enabled'));

const OPEN = /^app_store_billing_enabled\s*=\s*"1"\s*$/m;
const PAYMENTS_OPEN = /^payments_enabled\s*=\s*"1"\s*$/m;
// An assignment, not a mention: the production comment names the variable.
const NARROWED = /^\s*(APP_STORE_ENVIRONMENTS|app_store_environments)\s*=/m;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('app store billing: off by default', () => {
  it('both variable declarations are strings that default to "0"', () => {
    expect(defaultsOff(rootVariables)).toBe(true);
    expect(defaultsOff(apiVariables)).toBe(true);
  });

  it('the root variable only accepts the exact strings "0" and "1"', () => {
    expect(variableBlock(rootVariables, 'app_store_billing_enabled')).toContain(
      'contains(["0", "1"], var.app_store_billing_enabled)'
    );
  });
});

describe('app store billing: open in staging and production', () => {
  it('staging and production each set it to "1", once', () => {
    expect(stagingTfvars).toMatch(OPEN);
    expect(productionTfvars).toMatch(OPEN);
    expect(productionTfvars.match(/^app_store_billing_enabled\s*=/gm)).toHaveLength(1);
  });

  it('production also has payments open and no commercial hold, which the switch requires', () => {
    expect(productionTfvars).toMatch(PAYMENTS_OPEN);
    expect(commercialStatus.commercialHoldActive).toBe(false);
  });

  it('the root passes it to the api module, which sets it on the billing Lambda', () => {
    expect(rootModule).toMatch(/app_store_billing_enabled\s*=\s*var\.app_store_billing_enabled/);
    expect(apiModule).toMatch(/APP_STORE_BILLING_ENABLED\s*=\s*var\.app_store_billing_enabled/);
    expect(apiModule).toMatch(/billing\s*=\s*merge\(local\.stripe_environment,/);
  });

  it('the notifications route is public (Apple signs the body) and the other two need a sign-in', () => {
    expect(apiModule).toMatch(
      /"POST \/billing\/app-store\/notifications"\s*=\s*\{ group = "billing", auth = "none" \}/
    );
    expect(apiModule).toMatch(
      /"POST \/billing\/app-store\/purchase-intent"\s*=\s*\{ group = "billing", auth = "jwt" \}/
    );
    expect(apiModule).toMatch(
      /"POST \/billing\/app-store\/transactions"\s*=\s*\{ group = "billing", auth = "jwt" \}/
    );
  });
});

describe('Sandbox is accepted in production (App Review buys in Sandbox)', () => {
  it('no infrastructure file sets APP_STORE_ENVIRONMENTS', () => {
    for (const source of [apiModule, rootModule, productionTfvars, stagingTfvars]) {
      expect(source).not.toMatch(NARROWED);
    }
  });

  it('with APP_STORE_ENVIRONMENTS unset the backend accepts Production and Sandbox only', () => {
    const saved = process.env.APP_STORE_ENVIRONMENTS;
    delete process.env.APP_STORE_ENVIRONMENTS;
    const envs = appStoreEnvironments();
    if (saved !== undefined) process.env.APP_STORE_ENVIRONMENTS = saved;
    expect([...envs].sort()).toEqual(['Production', 'Sandbox']);
    expect(envs.has('Xcode')).toBe(false);
    expect(envs.has('LocalTesting')).toBe(false);
  });

  it('narrowing to Production drops Sandbox (the later, separate change)', () => {
    vi.stubEnv('APP_STORE_ENVIRONMENTS', 'Production');
    expect([...appStoreEnvironments()]).toEqual(['Production']);
  });
});

describe('the checks notice a regression (negative controls)', () => {
  it('a default flipped to "1" is caught', () => {
    const sabotaged = rootVariables.replace(
      /(variable "app_store_billing_enabled" \{[\s\S]*?default\s+=\s+)"0"/,
      '$1"1"'
    );
    expect(sabotaged).not.toBe(rootVariables);
    expect(defaultsOff(sabotaged)).toBe(false);
  });

  it('a production tfvars that turns it back off is caught', () => {
    const sabotaged = productionTfvars.replace(OPEN, 'app_store_billing_enabled = "0"');
    expect(sabotaged).not.toBe(productionTfvars);
    expect(sabotaged).not.toMatch(OPEN);
  });

  it('a near-miss value such as "true" is caught', () => {
    const sabotaged = productionTfvars.replace(OPEN, 'app_store_billing_enabled = "true"');
    expect(sabotaged).not.toBe(productionTfvars);
    expect(sabotaged).not.toMatch(OPEN);
  });

  it('a production tfvars that narrows the environments is caught', () => {
    const sabotaged = `${productionTfvars}\napp_store_environments = "Production"\n`;
    expect(productionTfvars).not.toMatch(NARROWED);
    expect(sabotaged).toMatch(NARROWED);
  });
});
