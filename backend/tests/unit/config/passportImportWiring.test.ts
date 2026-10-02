/**
 * Deployment wiring for the plant passport import (#676).
 *
 * The feature ships OFF and the owner turns it on with one Terraform variable.
 * Each check below fails silently in production if it is wrong: a default of
 * `true` would switch the feature on with the next signed tag; an environment
 * variable set unconditionally would do the same without the variable; a route
 * missing from the API Gateway table would 404 even after the switch; and a
 * route on the wrong `auth` would make the import public or the preview
 * private.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = new URL('../../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, repositoryRoot), 'utf8');

/** The `variable "name" { ... }` block, up to its closing brace at column 0. */
function variableBlock(source: string, name: string): string {
  const start = source.indexOf(`variable "${name}" {`);
  expect(start, `variable ${name} is declared`).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf('\n}\n', start));
}

function tfvarsFiles(dir: string): string[] {
  const root = new URL(dir, repositoryRoot).pathname;
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.tfvars')) out.push(full);
    }
  };
  walk(root);
  return out;
}

describe('plant passport import deployment wiring', () => {
  it('declares the switch off by default at the root and in the API module', () => {
    for (const file of ['infrastructure/variables.tf', 'infrastructure/modules/api/variables.tf']) {
      const block = variableBlock(read(file), 'passport_import_enabled');
      expect(block).toMatch(/type\s*=\s*bool/);
      expect(block).toMatch(/default\s*=\s*false/);
    }
  });

  it('is off in every committed tfvars, and set explicitly in production', () => {
    const files = tfvarsFiles('infrastructure/environments');
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/^\s*passport_import_enabled\s*=\s*true\b/m);
    }
    expect(read('infrastructure/environments/production/terraform.tfvars')).toMatch(
      /^passport_import_enabled\s*=\s*false\s*$/m
    );
  });

  it('passes the switch from the root module to the API module', () => {
    expect(read('infrastructure/main.tf')).toMatch(
      /passport_import_enabled\s*=\s*var\.passport_import_enabled/
    );
  });

  it('sets PASSPORT_IMPORT_ENABLED only on the plants Lambda, and only when the switch is on', () => {
    const api = read('infrastructure/modules/api/main.tf');
    // Code only: comments name the variable too.
    const code = api
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    const occurrences = code.match(/PASSPORT_IMPORT_ENABLED/g) ?? [];
    expect(occurrences).toHaveLength(1);
    // Conditional on the variable: with the switch off the environment map is
    // empty, so the Lambda's environment (and the plan) is unchanged.
    expect(api).toMatch(
      /passport_import_environment\s*=\s*var\.passport_import_enabled\s*\?\s*\{\s*PASSPORT_IMPORT_ENABLED\s*=\s*"1"\s*\}\s*:\s*\{\}/
    );
    // ...and merged into the plants Lambda's environment, and only there.
    expect(api).toMatch(/plants\s*=\s*merge\([^)]*local\.passport_import_environment\)/);
    expect(code.match(/local\.passport_import_environment/g)).toHaveLength(1);
    // Never in the environment every Lambda shares: that map runs from its
    // opening line to the first closing brace at the same indent.
    const lines = api.split('\n');
    const from = lines.findIndex((line) => /^ {2}lambda_environment = \{/.test(line));
    expect(from).toBeGreaterThanOrEqual(0);
    const to = lines.findIndex((line, index) => index > from && line === '  }');
    expect(to).toBeGreaterThan(from);
    expect(lines.slice(from, to + 1).join('\n')).not.toContain('PASSPORT_IMPORT');
  });

  it('wires the three routes on the existing plants Lambda with the right auth', () => {
    const api = read('infrastructure/modules/api/main.tf');
    const route = (key: string) => {
      const line = api.split('\n').find((l) => l.includes(`"${key}"`) && l.includes('group'));
      expect(line, `route ${key}`).toBeDefined();
      return line as string;
    };
    expect(route('POST /plants/{id}/passport-share')).toMatch(/group = "plants", auth = "jwt"/);
    // The preview is public by design, like the cutting preview.
    expect(route('GET /plants/shared/{code}/passport')).toMatch(/group = "plants", auth = "none"/);
    // The import is a signed-in member's act.
    expect(route('POST /plants/shared/{code}/passport/import')).toMatch(
      /group = "plants", auth = "jwt"/
    );
  });

  it('needs no new Lambda permission: the API Gateway grant is per function, for every route', () => {
    const api = read('infrastructure/modules/api/main.tf');
    const grant = api.slice(api.indexOf('resource "aws_lambda_permission" "api_gateway"'));
    expect(grant.slice(0, grant.indexOf('\n}\n'))).toMatch(
      /for_each\s*=\s*local\.lambda_handlers[\s\S]*source_arn\s*=\s*"\$\{aws_apigatewayv2_api\.main\.execution_arn\}\/\*\/\*"/
    );
    // And no function of its own: the routes are served by `plants`.
    expect(api).not.toMatch(/passport\s*=\s*\{[^}]*handler/);
  });
});
