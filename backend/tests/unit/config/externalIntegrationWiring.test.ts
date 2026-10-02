import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const repositoryRoot = new URL('../../../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, repositoryRoot), 'utf8');

describe('external integration deployment wiring', () => {
  const terraformRoot = read('infrastructure/main.tf');
  const terraformVariables = read('infrastructure/variables.tf');
  const apiModule = read('infrastructure/modules/api/main.tf');
  const stagingWorkflow = read('.github/workflows/cd-staging.yml');
  const productionWorkflow = read('.github/workflows/cd-production.yml');
  const cicdDocs = read('docs/cicd-setup.md');
  const frontendModule = read('infrastructure/modules/frontend/main.tf');

  it('carries Plant.id from a protected deploy secret to the plants Lambda', () => {
    expect(terraformVariables).toContain('variable "plant_id_api_key"');
    expect(terraformRoot).toMatch(/plant_id_api_key\s*=\s*var\.plant_id_api_key/);
    expect(apiModule).toMatch(/PLANT_ID_API_KEY\s*=\s*var\.plant_id_api_key/);
    expect(stagingWorkflow).toContain(
      'TF_VAR_plant_id_api_key: ${{ secrets.STAGING_PLANT_ID_API_KEY }}'
    );
    expect(productionWorkflow.match(/TF_VAR_plant_id_api_key:/g)).toHaveLength(2);
    expect(cicdDocs).toContain('PRODUCTION_PLANT_ID_API_KEY');
  });

  it('carries OpenWeather from protected deploy secrets to climate and chat', () => {
    expect(terraformVariables).toContain('variable "openweather_api_key"');
    expect(terraformRoot).toMatch(/openweather_api_key\s*=\s*var\.openweather_api_key/);
    expect(apiModule).toMatch(/OPENWEATHER_API_KEY\s*=\s*var\.openweather_api_key/);
    expect(stagingWorkflow).toContain(
      'TF_VAR_openweather_api_key: ${{ secrets.STAGING_OPENWEATHER_API_KEY }}'
    );
    expect(productionWorkflow.match(/TF_VAR_openweather_api_key:/g)).toHaveLength(2);
    expect(cicdDocs).toContain('PRODUCTION_OPENWEATHER_API_KEY');
  });

  it('keeps Perenual available to every handler that consumes enrichment', () => {
    expect(apiModule).toMatch(
      /plants\s*=\s*merge\(local\.plant_integration_environment,\s*local\.perenual_environment,\s*local\.identify_top_up_offer_environment(?:,\s*local\.passport_import_environment)?\)/
    );
    expect(apiModule).toMatch(
      /notifications\s*=\s*merge\(local\.notification_environment,\s*local\.perenual_environment\)/
    );
  });

  it('lets billing see whether identification is configured, and plants see the pack it can offer', () => {
    // Measured 2026-09-13: PLANT_ID_API_KEY had length 0 in production while the
    // $1.99 identification pack was on sale, and the billing Lambda was never
    // handed the key at all — so even a correctly set secret could not have
    // made the sale refuse. The plants Lambda, which answers the 402 at the cap,
    // had neither the pack's price id nor PAYMENTS_ENABLED, so it never offered
    // the pack in production. Each crossover is exactly one fact, never the
    // other handler's whole environment: billing must not receive the vendor's
    // leaf-health caps, and plants must not receive the Stripe secret.
    expect(apiModule).toMatch(
      /identify_configured_environment\s*=\s*\{\s*PLANT_ID_API_KEY\s*=\s*var\.plant_id_api_key\s*\}/
    );
    expect(apiModule).toMatch(
      /identify_top_up_offer_environment\s*=\s*\{\s*STRIPE_PRICE_ID_IDENTIFY_TOP_UP\s*=\s*var\.stripe_price_id_identify_top_up\s*PAYMENTS_ENABLED\s*=\s*var\.payments_enabled\s*\}/
    );
    expect(apiModule).toMatch(
      /billing\s*=\s*merge\(local\.stripe_environment,\s*local\.email_environment,\s*local\.identify_configured_environment\)/
    );
    // Only the two facts cross, in each direction.
    const offer = apiModule.match(/identify_top_up_offer_environment\s*=\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(offer).not.toContain('STRIPE_SECRET_KEY');
    expect(offer).not.toContain('STRIPE_WEBHOOK_SECRET');
    const configured =
      apiModule.match(/identify_configured_environment\s*=\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(configured).not.toContain('LEAF_HEALTH');
    expect(configured).not.toContain('BEDROCK');
  });

  it('builds and permits the optional Sentry and PostHog browser rails', () => {
    for (const wiring of [
      'VITE_SENTRY_DSN: ${{ secrets.PRODUCTION_FRONTEND_SENTRY_DSN }}',
      'VITE_POSTHOG_KEY: ${{ secrets.PRODUCTION_POSTHOG_KEY }}',
      'VITE_POSTHOG_HOST:',
    ]) {
      expect(productionWorkflow).toContain(wiring);
    }
    expect(productionWorkflow.match(/TF_VAR_sentry_dsn:/g)).toHaveLength(2);
    expect(productionWorkflow.match(/TF_VAR_posthog_key:/g)).toHaveLength(2);
    expect(stagingWorkflow).toContain(
      'VITE_SENTRY_DSN: ${{ secrets.STAGING_FRONTEND_SENTRY_DSN }}'
    );
    expect(frontendModule).toContain('https://us.i.posthog.com');
    expect(frontendModule).toContain('https://eu.i.posthog.com');
    expect(frontendModule).toContain('https://*.sentry.io');
  });

  it('carries the browser PostHog key from a REPOSITORY secret into a job with no environment', () => {
    // The `build` job is the only place VITE_* values become bytes in the
    // bundle, and it runs outside the `production` environment. An
    // environment-scoped PRODUCTION_POSTHOG_KEY would therefore reach it
    // empty: the deploy stays green and analytics ships dark. This pins the
    // shape the owner step in docs/analytics.md relies on.
    const buildJob = productionWorkflow.slice(
      productionWorkflow.indexOf('\n  build:'),
      productionWorkflow.indexOf('\n  terraform:')
    );
    expect(buildJob).not.toMatch(/^\s+environment:/m);
    expect(buildJob).toContain('VITE_POSTHOG_KEY: ${{ secrets.PRODUCTION_POSTHOG_KEY }}');
  });

  it('builds Google Analytics 4 into the production web bundle only', () => {
    // The 2026-09-17 decision (docs/analytics.md, "Google Analytics 4"): GA4 on
    // the website, never in the native shells. The measurement ID is public,
    // so it is a literal in the build job, not a secret; staging stays dark.
    const buildJob = productionWorkflow.slice(
      productionWorkflow.indexOf('\n  build:'),
      productionWorkflow.indexOf('\n  terraform:')
    );
    expect(buildJob).toMatch(/^\s+VITE_GA_MEASUREMENT_ID: G-L2JN3PQ75P$/m);
    expect(productionWorkflow.match(/VITE_GA_MEASUREMENT_ID:/g)).toHaveLength(1);
    expect(stagingWorkflow).not.toContain('VITE_GA_MEASUREMENT_ID');
    // gtag.js, not a Tag Manager container: no GTM build variable anywhere.
    for (const file of [productionWorkflow, stagingWorkflow, frontendModule]) {
      expect(file).not.toContain('GTM_ID');
    }
    // PostHog stays a fetch shim; GA lives in its own module.
    expect(read('frontend/src/services/analytics.ts')).not.toContain('dataLayer');
  });

  it('admits exactly the GA4 origins in both Content-Security-Policies', () => {
    const edge = frontendModule.match(/content_security_policy\s*=\s*"([^"]+)"/)?.[1] ?? '';
    const meta =
      read('frontend/index.html').match(
        /http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]+)"/
      )?.[1] ?? '';
    for (const policy of [edge, meta]) {
      const directive = (name: string) =>
        policy
          .split(';')
          .map((part) => part.trim())
          .find((part) => part.startsWith(`${name} `)) ?? '';
      expect(directive('script-src')).toBe("script-src 'self' https://www.googletagmanager.com");
      for (const name of ['connect-src', 'img-src']) {
        expect(directive(name)).toContain('https://*.google-analytics.com');
        expect(directive(name)).toContain('https://*.analytics.google.com');
      }
    }
    // The edge policy is the strict one: its connect-src lists hosts, so it is
    // what blocks gtag.js's www.google.com/g/collect mirror. Keep it blocked.
    expect(edge).not.toMatch(/connect-src[^;]*https:\/\/www\.google\.com/);
    expect(edge).not.toMatch(/connect-src[^;]*\shttps:(?:\s|;)/);
  });
});
