/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Canonical list of well-known default credentials baked into the Thunderbolt
 * deployment scaffolding (Pulumi, Helm, docker-compose, Keycloak realm).
 *
 * If any of these match a deployed value, the deployer almost certainly forgot
 * to override the default. Every layer that has access to live values
 * (Pulumi at deploy time, backend at startup, the /v1/api/config endpoint,
 * frontend on init, container entrypoints) consults this list and emits a
 * loud warning.
 *
 * Override behavior is suppressible via the `DANGEROUSLY_ALLOW_DEFAULT_CREDS`
 * env var (or `dangerouslyAllowDefaultCreds` Pulumi config) — intended only
 * for short-lived evaluation environments where defaults are accepted on
 * purpose.
 */

export type InsecureDefault = {
  /** Backend env var name. */
  envKey: string
  /** Pulumi config key (camelCase) used in deploy/pulumi/index.ts. */
  pulumiKey: string
  /** The literal sentinel value baked into deploy/ scaffolding. */
  defaultValue: string
  /** Human-readable description of what this credential protects. */
  description: string
}

export const INSECURE_DEFAULTS: readonly InsecureDefault[] = [
  {
    envKey: 'POSTGRES_PASSWORD',
    pulumiKey: 'postgresPassword',
    defaultValue: 'postgres',
    description: 'PostgreSQL admin password',
  },
  {
    envKey: 'KC_BOOTSTRAP_ADMIN_PASSWORD',
    pulumiKey: 'keycloakAdminPassword',
    defaultValue: 'admin',
    description: 'Keycloak admin console password',
  },
  {
    envKey: 'OIDC_CLIENT_SECRET',
    pulumiKey: 'oidcClientSecret',
    defaultValue: 'thunderbolt-enterprise-secret',
    description: 'OIDC client secret (also baked into deploy/config/keycloak-realm.json)',
  },
  {
    envKey: 'POWERSYNC_JWT_SECRET',
    pulumiKey: 'powersyncJwtSecret',
    defaultValue: 'enterprise-thunderbolt-powersync-jwt-default-secret',
    description: 'PowerSync JWT signing secret',
  },
  {
    envKey: 'BETTER_AUTH_SECRET',
    pulumiKey: 'betterAuthSecret',
    defaultValue: 'enterprise-thunderbolt-better-auth-default-secret',
    description: 'Better Auth session signing secret',
  },
  {
    envKey: 'POWERSYNC_DB_PASSWORD',
    pulumiKey: 'powersyncDbPassword',
    defaultValue: 'myhighlyrandompassword',
    description: 'PowerSync database role password',
  },
] as const

/** Public docs anchor that warning surfaces should link to. */
export const INSECURE_DEFAULTS_DOCS_URL =
  'https://github.com/thunderbird/thunderbolt/blob/main/deploy/README.md#default-credentials'

/**
 * Returns true if the deployer has explicitly opted into running with
 * default credentials via `DANGEROUSLY_ALLOW_DEFAULT_CREDS=true`. Any other
 * spelling (including the typo-prone `DANGEROUS_*`) is intentionally NOT
 * accepted — silently honoring a misspelled override means an operator
 * thinks they suppressed warnings when they haven't.
 */
export const isInsecureDefaultsHushed = (env: Record<string, string | undefined>): boolean => {
  const v = env.DANGEROUSLY_ALLOW_DEFAULT_CREDS
  return !!v && v.toLowerCase() === 'true'
}

/**
 * Detect which entries in INSECURE_DEFAULTS are currently live, given a
 * resolver (e.g. an env-var lookup, or a Pulumi-config lookup). Returns an
 * empty array when the deployer has hushed warnings via the env var.
 *
 * The resolver receives both the envKey and pulumiKey so callers can choose
 * which one to consult based on their context.
 */
export const detectInsecureDefaults = (
  resolve: (entry: InsecureDefault) => string | undefined,
  env: Record<string, string | undefined> = {},
): InsecureDefault[] => {
  if (isInsecureDefaultsHushed(env)) {
    return []
  }
  return INSECURE_DEFAULTS.filter((entry) => {
    const value = resolve(entry)
    return value !== undefined && value === entry.defaultValue
  })
}

/**
 * Render a multi-line ANSI-colored terminal banner. Used by backend startup
 * logs and the frontend container entrypoint.
 *
 * Pass `useColor: false` for environments that don't support ANSI escapes
 * (CI logs, files redirected from a TTY).
 */
export const renderTerminalBanner = (matches: InsecureDefault[], useColor = true): string => {
  const RED_BG = useColor ? '\x1b[41m' : ''
  const WHITE_BOLD = useColor ? '\x1b[1;37m' : ''
  const YELLOW = useColor ? '\x1b[1;33m' : ''
  const DIM = useColor ? '\x1b[2m' : ''
  const RESET = useColor ? '\x1b[0m' : ''

  const width = 78
  // Pad the plain visible text first, then wrap with color codes — ANSI escapes
  // are zero-width visually but would otherwise inflate `s.length`, throwing
  // off the right-hand `║` border alignment.
  const pad = (s: string): string => s + ' '.repeat(Math.max(0, width - s.length))
  const line = (s: string, inner = `${RED_BG}${WHITE_BOLD}`): string =>
    `${RED_BG}${WHITE_BOLD}║ ${inner}${pad(s)}${RESET}${RED_BG}${WHITE_BOLD} ║${RESET}`
  const top = `${RED_BG}${WHITE_BOLD}╔${'═'.repeat(width + 2)}╗${RESET}`
  const bot = `${RED_BG}${WHITE_BOLD}╚${'═'.repeat(width + 2)}╝${RESET}`
  const blank = line('')

  const rows: string[] = [
    '',
    top,
    blank,
    line('  🚨🚨🚨   INSECURE DEFAULT CREDENTIALS DETECTED   🚨🚨🚨'),
    blank,
    line('  This Thunderbolt deployment is using well-known default values for:'),
    blank,
    ...matches.map((m) => line(`    • ${m.envKey}  —  ${m.description}`)),
    blank,
    line('  These values are public in the source tree. Anyone who knows the'),
    line('  deployment exists can read them. Rotate before exposing this'),
    line('  instance to the internet.'),
    blank,
    line('  Docs (override per platform):'),
    line(`  ${INSECURE_DEFAULTS_DOCS_URL}`),
    blank,
    line('  Suppress with: DANGEROUSLY_ALLOW_DEFAULT_CREDS=true', `${YELLOW}`),
    blank,
    bot,
    '',
  ]

  return rows.join('\n') + DIM + '' + RESET
}
