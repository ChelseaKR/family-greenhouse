/**
 * Uploads that are never confirmed are removed by the bucket itself
 * (ADR 0046), measured on the Terraform that builds production.
 *
 * A client's photo lands under `uploads/` and the confirm step moves on from
 * there. An upload nobody confirms is an object no row points at, and nothing
 * in the application will ever look for it. So the cleanup is a lifecycle rule,
 * and a lifecycle rule that is missing, disabled or scoped to the wrong prefix
 * is silent: nothing errors, the objects just stay. This pins it.
 *
 * The API role's list permission is pinned too: it stays scoped to the two
 * prefixes the API enumerates, and the holding prefix is not one of them.
 *
 * Each negative control asserts its sabotage changed the text before asserting
 * the check notices, so a replacement that matched nothing cannot read as a pass.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

const frontendModule = read('infrastructure/modules/frontend/main.tf');
const apiModule = read('infrastructure/modules/api/main.tf');

/** A block's body from `header` to its matching brace. */
function block(source: string, header: RegExp): string {
  const match = header.exec(source);
  if (!match) return '';
  let depth = 1;
  let i = match.index + match[0].length;
  while (depth > 0 && i < source.length) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') depth -= 1;
    i += 1;
  }
  return source.slice(match.index, i);
}

/** Every `rule { ... }` of the images bucket's lifecycle configuration. */
function imageLifecycleRules(source: string): string[] {
  const config = block(
    source,
    /resource\s+"aws_s3_bucket_lifecycle_configuration"\s+"images"\s*\{/
  );
  const rules: string[] = [];
  const header = /\n\s*rule\s*\{/g;
  for (const match of config.matchAll(header)) {
    rules.push(block(config.slice(match.index), /rule\s*\{/));
  }
  return rules;
}

const number = (text: string, name: string): number | null => {
  const match = new RegExp(`${name}\\s*=\\s*(\\d+)`).exec(text);
  return match ? Number(match[1]) : null;
};

/**
 * The rule that expires unconfirmed uploads: enabled, scoped to exactly
 * `uploads/`, removing the current object within a day and the version
 * behind it within a day after that.
 */
function expiresUnconfirmedUploads(source: string): boolean {
  return imageLifecycleRules(source).some((rule) => {
    const days = number(block(rule, /\n\s*expiration\s*\{/), 'days');
    const noncurrent = number(block(rule, /noncurrent_version_expiration\s*\{/), 'noncurrent_days');
    return (
      /status\s*=\s*"Enabled"/.test(rule) &&
      /filter\s*\{\s*prefix\s*=\s*"uploads\/"\s*\}/.test(rule) &&
      days !== null &&
      days <= 1 &&
      noncurrent !== null &&
      noncurrent <= 1
    );
  });
}

describe('unconfirmed uploads are removed by the images bucket', () => {
  it('a lifecycle rule expires everything under uploads/ within a day, versions included', () => {
    expect(expiresUnconfirmedUploads(frontendModule)).toBe(true);
  });

  it('no lifecycle rule expires stored photos: only uploads/ and trash/ carry an expiry', () => {
    const expiring = imageLifecycleRules(frontendModule).filter((rule) =>
      /\n\s*expiration\s*\{/.test(rule)
    );
    const prefixes = expiring.map((rule) => /prefix\s*=\s*"([^"]*)"/.exec(rule)?.[1] ?? '');
    expect(prefixes.sort()).toEqual(['trash/', 'uploads/']);
  });

  it('the API role lists only plants/ and trash/, not the holding prefix', () => {
    expect(apiModule).toMatch(/"s3:prefix"\s*=\s*\["plants\/\*", "trash\/\*"\]/);
  });
});

describe('the checks notice a regression (negative controls)', () => {
  it('a missing rule is caught', () => {
    const sabotaged = frontendModule.replace(/prefix = "uploads\/"/, 'prefix = "elsewhere/"');
    expect(sabotaged).not.toBe(frontendModule);
    expect(expiresUnconfirmedUploads(sabotaged)).toBe(false);
  });

  it('a disabled rule is caught', () => {
    const sabotaged = frontendModule.replace(
      /(id\s*=\s*"expire-unconfirmed-uploads"\s*\n\s*status\s*=\s*)"Enabled"/,
      '$1"Disabled"'
    );
    expect(sabotaged).not.toBe(frontendModule);
    expect(expiresUnconfirmedUploads(sabotaged)).toBe(false);
  });

  it('a rule that keeps uploads for a month is caught', () => {
    const rule = imageLifecycleRules(frontendModule).find((r) => r.includes('"uploads/"'))!;
    const sabotaged = frontendModule.replace(rule, rule.replace(/days = 1\b/, 'days = 30'));
    expect(sabotaged).not.toBe(frontendModule);
    expect(expiresUnconfirmedUploads(sabotaged)).toBe(false);
  });

  it('a rule that keeps old versions of uploads is caught', () => {
    const rule = imageLifecycleRules(frontendModule).find((r) => r.includes('"uploads/"'))!;
    const sabotaged = frontendModule.replace(
      rule,
      rule.replace(/noncurrent_days = 1\b/, 'noncurrent_days = 30')
    );
    expect(sabotaged).not.toBe(frontendModule);
    expect(expiresUnconfirmedUploads(sabotaged)).toBe(false);
  });
});
