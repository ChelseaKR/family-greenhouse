// Mobile Lighthouse CI config. Same routes, throttled to a slow 4G + Moto G4
// CPU profile (Lighthouse defaults for `mobile` preset).
const previewUrl = process.env.LHCI_BASE_URL || 'http://localhost:4173';

module.exports = {
  ci: {
    collect: {
      startServerCommand: 'npm run preview -- --port=4173 --strictPort',
      startServerReadyPattern: 'Local:',
      url: [`${previewUrl}/`, `${previewUrl}/login`],
      numberOfRuns: 3,
      settings: {
        // Mobile is the harsher target — score regressions show up here first.
        // Don't use a preset; mobile is Lighthouse's default and we want all
        // four category audits to run, not just performance.
        formFactor: 'mobile',
        screenEmulation: {
          mobile: true,
          width: 412,
          height: 823,
          deviceScaleFactor: 1.75,
          disabled: false,
        },
        throttling: {
          rttMs: 150,
          throughputKbps: 1638.4,
          cpuSlowdownMultiplier: 4,
          requestLatencyMs: 562.5,
          downloadThroughputKbps: 1474.56,
          uploadThroughputKbps: 675,
        },
        chromeFlags: '--no-sandbox --headless=new',
      },
    },
    assert: {
      assertions: {
        // Slightly looser perf budget on mobile — still must clear 0.85 (good).
        'categories:performance': ['error', { minScore: 0.85 }],
        'categories:accessibility': ['error', { minScore: 0.95 }],
        'categories:best-practices': ['error', { minScore: 0.9 }],
        'categories:seo': ['error', { minScore: 0.9 }],
        'largest-contentful-paint': ['error', { maxNumericValue: 4000 }],
        'cumulative-layout-shift': ['error', { maxNumericValue: 0.1 }],
        'total-blocking-time': ['error', { maxNumericValue: 600 }],
        'is-on-https': 'off',
        'uses-text-compression': 'off',
        'uses-long-cache-ttl': 'off',
        'csp-xss': 'off',
      },
    },
    upload: {
      target: 'filesystem',
      outputDir: '.lighthouseci/mobile',
      reportFilenamePattern: '%%PATHNAME%%-%%DATETIME%%-report.%%EXTENSION%%',
    },
  },
};
