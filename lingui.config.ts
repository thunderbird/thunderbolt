/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defineConfig } from '@lingui/cli'
import { formatter } from '@lingui/format-po-gettext'
import { appLocales, pseudoLocale, sourceLocale } from './shared/i18n/locales'

/**
 * Lingui configuration (THU-806).
 *
 * - `po-gettext` (not the default `po`): Pontoon renders native gettext
 *   plurals (`msgid_plural` / `msgstr[N]`) with per-locale plural inputs,
 *   while ICU embedded in a single msgid shows up as raw text a translator
 *   has to hand-edit. Accepted tradeoff: `select` / `selectOrdinal` cannot be
 *   expressed in this format, so those macros are off-limits codebase-wide.
 * - `en-XA` is the CI pseudo-locale: its catalog is compiled by
 *   pseudo-localizing the English source, which makes hardcoded strings and
 *   text-expansion layout breaks visible without a translator.
 */
export default defineConfig({
  sourceLocale,
  locales: [...appLocales],
  pseudoLocale,
  fallbackLocales: {
    default: sourceLocale,
  },
  catalogs: [
    {
      path: '<rootDir>/src/locales/{locale}/messages',
      include: ['src'],
      exclude: [
        '**/*.test.*',
        '**/test-utils/**',
        '**/*.stories.*',
        '**/*.d.ts',
        // Generated wasm-bindgen glue (build artifact, breaks the parser).
        'src/acp/iroh/pkg/**',
        // Dev-only surfaces (both gated on `import.meta.env.DEV` in src/app.tsx).
        // No shipped build renders them, so putting their strings in front of
        // translators would only spend volunteer effort on developer tooling.
        'src/devtools/**',
        'src/settings/dev-settings.tsx',
      ],
    },
  ],
  // Keep file-path origins but drop line numbers: with line numbers, any
  // edit that merely shifts a macro call to a new line rewrites the `#:`
  // references in every catalog and trips the CI extraction check without a
  // single string changing.
  format: formatter({ lineNumbers: false }),
})
