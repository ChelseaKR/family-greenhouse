/**
 * Deployment wiring for "a changed email address takes effect only after it is
 * verified" (ADR 0048).
 *
 * The setting is one block on the user pool, and its ABSENCE is silent: the
 * pool still accepts the change, applies it at once and marks the address
 * unverified. Nothing errors. So the block, the two things it depends on, and
 * the sentence in docs/security.md that describes it are asserted here rather
 * than left to a reviewer noticing a deleted line.
 *
 * Each negative control asserts its sabotage changed the text before asserting
 * the check notices, so a replacement that matched nothing cannot read as a pass.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

const authModule = read('infrastructure/modules/auth/main.tf');
const securityDoc = read('docs/security.md');

/** The body of one `resource "<type>" "main" { ... }` block, to its closing brace at column 0. */
const resourceBlock = (source: string, type: string): string => {
  const start = source.indexOf(`resource "${type}" "main" {`);
  if (start < 0) return '';
  return source.slice(start, source.indexOf('\n}\n', start) + 3);
};

/** The string items of `name = [ ... ]` inside a block. */
const listOf = (block: string, name: string): string[] => {
  const match = new RegExp(`\\n\\s*${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(block);
  return match ? [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
};

const requiresVerificationBeforeUpdate = (source: string): boolean => {
  const pool = resourceBlock(source, 'aws_cognito_user_pool');
  const settings = /user_attribute_update_settings\s*\{([^}]*)\}/.exec(pool)?.[1] ?? '';
  return (
    listOf(`\n${settings}`, 'attributes_require_verification_before_update').includes('email') &&
    // The pool refuses the setting unless it also verifies email by itself.
    listOf(pool, 'auto_verified_attributes').includes('email')
  );
};

const tokenSaysWhetherEmailIsVerified = (source: string): boolean =>
  listOf(resourceBlock(source, 'aws_cognito_user_pool_client'), 'read_attributes').includes(
    'email_verified'
  );

describe('a changed email address must be verified before it takes effect', () => {
  it('the user pool holds an email change until the new address is verified', () => {
    expect(requiresVerificationBeforeUpdate(authModule)).toBe(true);
  });

  it('the app client can read email_verified, so the ID token carries it', () => {
    expect(tokenSaysWhetherEmailIsVerified(authModule)).toBe(true);
  });

  it('the app client can write only email and name: never the household attributes, never email_verified', () => {
    const client = resourceBlock(authModule, 'aws_cognito_user_pool_client');
    expect(listOf(client, 'write_attributes').sort()).toEqual(['email', 'name']);
  });

  it('docs/security.md states the setting by name, and no longer states it as a bare claim', () => {
    expect(securityDoc).toContain('attributes_require_verification_before_update');
    expect(securityDoc).toContain('emailChangeVerificationWiring.test.ts');
  });
});

describe('the checks notice a regression (negative controls)', () => {
  it('a pool without the block is caught', () => {
    const sabotaged = authModule.replace(/\n\s*user_attribute_update_settings\s*\{[^}]*\}\n/, '\n');
    expect(sabotaged).not.toBe(authModule);
    expect(requiresVerificationBeforeUpdate(sabotaged)).toBe(false);
  });

  it('a block that no longer names email is caught', () => {
    const sabotaged = authModule.replace(
      /attributes_require_verification_before_update\s*=\s*\["email"\]/,
      'attributes_require_verification_before_update = []'
    );
    expect(sabotaged).not.toBe(authModule);
    expect(requiresVerificationBeforeUpdate(sabotaged)).toBe(false);
  });

  it('a pool that stops auto-verifying email is caught', () => {
    const sabotaged = authModule.replace(
      /auto_verified_attributes\s*=\s*\["email"\]/,
      'auto_verified_attributes = []'
    );
    expect(sabotaged).not.toBe(authModule);
    expect(requiresVerificationBeforeUpdate(sabotaged)).toBe(false);
  });

  it('a client that can no longer read email_verified is caught', () => {
    const sabotaged = authModule.replace(/\n\s*"email_verified",/, '');
    expect(sabotaged).not.toBe(authModule);
    expect(tokenSaysWhetherEmailIsVerified(sabotaged)).toBe(false);
  });
});
