/**
 * Deployment wiring for Apple In-App Purchase (ADR 0041).
 *
 * OFF BY DEFAULT, ON IN STAGING AND PRODUCTION: both variable declarations
 * default to "0", and each environment opens it with its own reviewed tfvars
 * line.
 *
 * WHICH ENVIRONMENTS GRANT A PLAN (ADR 0045): Production only, in the backend
 * default, in both Terraform defaults and in the production tfvars. Sandbox is
 * an opt-in an environment writes out: staging always, production only for the
 * days around an App Store submission.
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
// An assignment, not a mention: the tfvars comments name both values.
const ENVIRONMENTS = /^app_store_environments\s*=\s*"([^"]*)"\s*$/gm;
const environmentsSetIn = (tfvars: string): string[] =>
  [...tfvars.matchAll(ENVIRONMENTS)].map((m) => m[1]);
/**
 * Production's line is acceptable in two shapes: closed ("Production"), or
 * open for a review with a dated note on the line directly above it, so the
 * opt-in is deliberate and says when it began:
 *
 *   # sandbox-window: opened 2027-01-05 for App Review
 *   app_store_environments = "Production,Sandbox"
 */
const SANDBOX_WINDOW =
  /^# sandbox-window: opened \d{4}-\d{2}-\d{2}\b[^\n]*\napp_store_environments\s*=\s*"Production,Sandbox"\s*$/m;
const productionEnvironmentsOk = (tfvars: string): boolean => {
  const set = environmentsSetIn(tfvars);
  if (set.length !== 1) return false;
  return (
    set[0] === 'Production' || (set[0] === 'Production,Sandbox' && SANDBOX_WINDOW.test(tfvars))
  );
};
const defaultsToProduction = (source: string): boolean =>
  /type\s+=\s+string/.test(variableBlock(source, 'app_store_environments')) &&
  /default\s+=\s+"Production"\n/.test(variableBlock(source, 'app_store_environments'));

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

describe('production grants a plan for Production transactions only (ADR 0045)', () => {
  it('with APP_STORE_ENVIRONMENTS unset the backend accepts Production only', () => {
    const saved = process.env.APP_STORE_ENVIRONMENTS;
    delete process.env.APP_STORE_ENVIRONMENTS;
    const envs = appStoreEnvironments();
    if (saved !== undefined) process.env.APP_STORE_ENVIRONMENTS = saved;
    expect([...envs]).toEqual(['Production']);
  });

  it('Sandbox is accepted only when the variable names it', () => {
    vi.stubEnv('APP_STORE_ENVIRONMENTS', 'Production,Sandbox');
    expect([...appStoreEnvironments()].sort()).toEqual(['Production', 'Sandbox']);
    vi.stubEnv('APP_STORE_ENVIRONMENTS', 'Production');
    expect([...appStoreEnvironments()]).toEqual(['Production']);
  });

  it('a value that names neither environment accepts nothing, and Xcode is never accepted', () => {
    for (const value of ['', 'sandbox', 'Xcode', 'LocalTesting', 'true', 'Production;Sandbox']) {
      vi.stubEnv('APP_STORE_ENVIRONMENTS', value);
      expect([...appStoreEnvironments()], value).toEqual([]);
    }
    vi.stubEnv('APP_STORE_ENVIRONMENTS', 'Production,Sandbox,Xcode,LocalTesting');
    expect([...appStoreEnvironments()].sort()).toEqual(['Production', 'Sandbox']);
  });

  it('both variable declarations are strings that default to "Production"', () => {
    expect(defaultsToProduction(rootVariables)).toBe(true);
    expect(defaultsToProduction(apiVariables)).toBe(true);
  });

  it('the root variable only accepts the two exact values', () => {
    expect(variableBlock(rootVariables, 'app_store_environments')).toContain(
      'contains(["Production", "Production,Sandbox"], var.app_store_environments)'
    );
  });

  it('the root passes it to the api module, which sets it on the billing Lambda', () => {
    expect(rootModule).toMatch(/app_store_environments\s*=\s*var\.app_store_environments/);
    expect(apiModule).toMatch(/APP_STORE_ENVIRONMENTS\s*=\s*var\.app_store_environments/);
  });

  it('production sets it once, in writing: closed, or open with a dated window note', () => {
    expect(productionEnvironmentsOk(productionTfvars)).toBe(true);
  });

  it('an open window is accepted only with its dated note directly above the line', () => {
    const closed = /^app_store_environments\s*=\s*"Production"\s*$/m;
    const open = 'app_store_environments = "Production,Sandbox"';
    const noted = productionTfvars.replace(
      closed,
      `# sandbox-window: opened 2027-01-05 for App Review\n${open}`
    );
    expect(noted).not.toBe(productionTfvars);
    expect(productionEnvironmentsOk(noted)).toBe(true);
    const undated = productionTfvars.replace(closed, `# sandbox-window: opened soon\n${open}`);
    expect(productionEnvironmentsOk(undated)).toBe(false);
    const apart = productionTfvars.replace(
      closed,
      `# sandbox-window: opened 2027-01-05\n\n${open}`
    );
    expect(productionEnvironmentsOk(apart)).toBe(false);
  });

  it('staging opts in to Sandbox, in writing', () => {
    expect(environmentsSetIn(stagingTfvars)).toEqual(['Production,Sandbox']);
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

  it('a production tfvars that accepts Sandbox with no window note is caught', () => {
    const sabotaged = productionTfvars.replace(
      /^app_store_environments\s*=\s*"Production"\s*$/m,
      'app_store_environments = "Production,Sandbox"'
    );
    expect(sabotaged).not.toBe(productionTfvars);
    expect(productionEnvironmentsOk(sabotaged)).toBe(false);
  });

  it('a production tfvars that drops the line is caught, even though the default is safe', () => {
    const sabotaged = productionTfvars.replace(/^app_store_environments\s*=.*$/m, '');
    expect(sabotaged).not.toBe(productionTfvars);
    expect(productionEnvironmentsOk(sabotaged)).toBe(false);
  });

  it('a production tfvars that sets it twice is caught', () => {
    const sabotaged = `${productionTfvars}\napp_store_environments = "Production"\n`;
    expect(productionEnvironmentsOk(sabotaged)).toBe(false);
  });

  it('a Terraform default that accepts Sandbox is caught', () => {
    const sabotaged = rootVariables.replace(
      /(variable "app_store_environments" \{[\s\S]*?default\s+=\s+)"Production"/,
      '$1"Production,Sandbox"'
    );
    expect(sabotaged).not.toBe(rootVariables);
    expect(defaultsToProduction(sabotaged)).toBe(false);
  });
});
