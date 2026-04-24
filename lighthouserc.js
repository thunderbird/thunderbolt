/** @type {import('@lhci/types').LHCI.UserConfig} */
module.exports = {
  ci: {
    collect: {
      numberOfRuns: 3,
      settings: {
        // Skip audits that aren't relevant for an SPA behind auth
        skipAudits: ['redirects-http', 'is-crawlable'],
      },
    },
    upload: {
      // Temporary public storage — no server needed.
      // Results are available for ~7 days at the printed URL.
      target: 'temporary-public-storage',
    },
    assert: {
      // Informational only — log warnings but never fail CI.
      preset: 'lighthouse:recommended',
      assertions: {
        // Override every category to warn-only so CI stays green.
        'categories:performance': ['warn', { minScore: 0.8 }],
        'categories:accessibility': ['warn', { minScore: 0.9 }],
        'categories:best-practices': ['warn', { minScore: 0.9 }],
        'categories:seo': ['warn', { minScore: 0.8 }],
        // Key web vitals — warn thresholds only.
        'first-contentful-paint': ['warn', { maxNumericValue: 2000 }],
        'largest-contentful-paint': ['warn', { maxNumericValue: 2500 }],
        'total-blocking-time': ['warn', { maxNumericValue: 300 }],
        'cumulative-layout-shift': ['warn', { maxNumericValue: 0.1 }],
      },
    },
  },
}
