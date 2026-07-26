import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const repositoryRoot = new URL('../../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, repositoryRoot), 'utf8');

describe('notification delivery deployment wiring', () => {
  const terraformRoot = read('infrastructure/main.tf');
  const terraformVariables = read('infrastructure/variables.tf');
  const stagingWorkflow = read('.github/workflows/cd-staging.yml');
  const productionWorkflow = read('.github/workflows/cd-production.yml');
  const manualDeploy = read('scripts/deploy.sh');

  it('passes the verified SES sender and VAPID values into the API module', () => {
    expect(terraformRoot).toMatch(/ses_from_email\s*=\s*var\.email_from_address/);
    expect(terraformRoot).toMatch(/web_push_vapid_public_key\s*=\s*var\.web_push_vapid_public_key/);
    expect(terraformRoot).toMatch(
      /web_push_vapid_private_key\s*=\s*var\.web_push_vapid_private_key/
    );
    expect(terraformRoot).toMatch(/web_push_vapid_subject\s*=\s*var\.web_push_vapid_subject/);
    for (const variable of [
      'web_push_vapid_public_key',
      'web_push_vapid_private_key',
      'web_push_vapid_subject',
    ]) {
      expect(terraformVariables).toContain(`variable "${variable}"`);
    }
  });

  it('uses the same environment public key in each browser build and Lambda plan', () => {
    expect(stagingWorkflow).toContain(
      'VITE_VAPID_PUBLIC_KEY: ${{ needs.terraform.outputs.web_push_vapid_public_key }}'
    );
    expect(stagingWorkflow).toContain(
      'TF_VAR_web_push_vapid_private_key: ${{ secrets.STAGING_WEB_PUSH_VAPID_PRIVATE_KEY }}'
    );
    expect(productionWorkflow).toContain(
      'VITE_VAPID_PUBLIC_KEY: ${{ vars.PRODUCTION_WEB_PUSH_VAPID_PUBLIC_KEY }}'
    );
    expect(productionWorkflow).toContain(
      'TF_VAR_web_push_vapid_private_key: ${{ secrets.PRODUCTION_WEB_PUSH_VAPID_PRIVATE_KEY }}'
    );
    expect(manualDeploy).toContain('VITE_VAPID_PUBLIC_KEY="$VAPID_PUBLIC_KEY"');
  });

  it('deploys digest code to staging and prevents stale service-worker scripts', () => {
    expect(stagingWorkflow).toMatch(
      /for handler in [^\n]*\breminders\b[^\n]*\bdigests\b[^\n]*; do/
    );
    for (const deploySurface of [stagingWorkflow, productionWorkflow, manualDeploy]) {
      expect(deploySurface).toContain('--exclude "sw.js"');
      expect(deploySurface).toContain('--exclude "push-handler.js"');
      expect(deploySurface).toMatch(
        /(?:dist|frontend\/dist)\/sw\.js[\s\S]{0,250}max-age=0,no-cache,no-store,must-revalidate/
      );
      expect(deploySurface).toMatch(
        /(?:dist|frontend\/dist)\/push-handler\.js[\s\S]{0,250}max-age=0,no-cache,no-store,must-revalidate/
      );
    }
  });
});
