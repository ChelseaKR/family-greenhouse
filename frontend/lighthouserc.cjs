// Default Lighthouse CI config — desktop profile.
//
// Run via `npm run lighthouse:desktop` (alias: `npm run lighthouse`).
// For mobile, use `npm run lighthouse:mobile` which loads `lighthouserc.mobile.cjs`.
//
// Both configs target the same routes against `vite preview` (production
// build). Dev mode is unminified and instrumented with React DevTools, which
// tanks scores misleadingly — never run LHCI against `npm run dev`.
const previewUrl = process.env.LHCI_BASE_URL || 'http://localhost:4173';

module.exports = {
  ci: {
    collect: {
      startServerCommand: 'npm run preview -- --port=4173 --strictPort',
      startServerReadyPattern: 'Local:',
      url: [`${previewUrl}/`, `${previewUrl}/login`],
      numberOfRuns: 3,
      settings: {
        preset: 'desktop',
        chromeFlags: '--no-sandbox --headless=new',
      },
    },
    assert: {
      assertions: {
        'categories:performance': ['error', { minScore: 0.9 }],
        'categories:accessibility': ['error', { minScore: 0.95 }],
        'categories:best-practices': ['error', { minScore: 0.9 }],
        'categories:seo': ['error', { minScore: 0.9 }],
        'largest-contentful-paint': ['error', { maxNumericValue: 2500 }],
        'cumulative-layout-shift': ['error', { maxNumericValue: 0.1 }],
        'total-blocking-time': ['error', { maxNumericValue: 300 }],
        // Can't be fixed by app code on a vite-preview server.
        'is-on-https': 'off',
        'uses-text-compression': 'off',
        'uses-long-cache-ttl': 'off',
        'csp-xss': 'off',
      },
    },
    upload: {
      target: 'filesystem',
      outputDir: '.lighthouseci/desktop',
      reportFilenamePattern: '%%PATHNAME%%-%%DATETIME%%-report.%%EXTENSION%%',
    },
  },
};
