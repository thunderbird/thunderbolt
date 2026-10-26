/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The attribute is required: Playwright's ESM loader rejects a JSON import without it.
import defaults from './ports.json' with { type: 'json' }

const urlFor = (name: 'QA_FRONTEND_PORT' | 'QA_ONBOARDING_PORT', env: Record<string, string | undefined>) =>
  `http://localhost:${env[name] || defaults[name]}`

/**
 * The URLs of the stack's two frontends. A port comes from `env`, or from `ports.json` when the variable is unset or
 * empty, the same rule the shell scripts use.
 */
export const stackURLs = (env: Record<string, string | undefined>) => ({
  frontend: urlFor('QA_FRONTEND_PORT', env),
  onboarding: urlFor('QA_ONBOARDING_PORT', env),
})

/** The frontend with onboarding off, and the one with onboarding on, for the current process environment. */
export const { frontend: frontendURL, onboarding: onboardingURL } = stackURLs(process.env)
