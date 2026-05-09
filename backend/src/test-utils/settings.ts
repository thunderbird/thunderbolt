/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Settings } from '@/config/settings'

/**
 * Creates a fully-populated `Settings` object for tests.
 * Pass `overrides` to set specific fields; everything else gets safe defaults
 * matching the schema in `@/config/settings`.
 */
export const createTestSettings = (overrides: Partial<Settings> = {}): Settings => ({
  fireworksApiKey: '',
  mistralApiKey: '',
  anthropicApiKey: '',
  exaApiKey: '',
  thunderboltInferenceUrl: '',
  thunderboltInferenceApiKey: '',
  monitoringToken: '',
  googleClientId: '',
  googleClientSecret: '',
  microsoftClientId: '',
  microsoftClientSecret: '',
  authMode: 'consumer' as const,
  oidcClientId: '',
  oidcClientSecret: '',
  oidcIssuer: '',
  oidcDiscoveryUrl: '',
  samlEntryPoint: '',
  samlEntityId: '',
  samlIdpIssuer: '',
  samlCert: '',
  betterAuthUrl: 'http://localhost:8000',
  betterAuthSecret: 'test-secret-at-least-32-chars-long!!',
  logLevel: 'INFO' as const,
  port: 8000,
  appUrl: 'http://localhost:1420',
  posthogHost: 'https://us.i.posthog.com',
  posthogApiKey: '',
  waitlistEnabled: false,
  waitlistAutoApproveDomains: '',
  powersyncUrl: '',
  powersyncJwtKid: '',
  powersyncJwtSecret: '',
  powersyncTokenExpirySeconds: 3600,
  corsOrigins: 'http://localhost:1420',
  corsAllowCredentials: true,
  corsAllowMethods: 'GET,POST,PUT,DELETE,PATCH,OPTIONS',
  corsAllowHeaders: 'Content-Type,Authorization',
  corsExposeHeaders: '',
  e2eeEnabled: false,
  swaggerEnabled: false,
  rateLimitEnabled: false,
  trustedProxy: '' as const,
  ...overrides,
})
