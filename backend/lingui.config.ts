/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { defineConfig } from '@lingui/cli'
import { formatter } from '@lingui/format-po-gettext'
import { appLocales, pseudoLocale, sourceLocale } from '../shared/i18n/locales'

/**
 * Lingui configuration for transactional email (THU-824).
 *
 * A second config rather than a second catalog in the root `lingui.config.ts`,
 * because `lingui compile` has no per-catalog filter — only `--config`. Sharing
 * one config would mean compiling the frontend's ~1000-message catalog too, and
 * committing seven large generated files that Vite never reads.
 *
 * The catalog is small (the email templates are the only place the backend
 * authors prose) but it goes through the same `po-gettext` format as the
 * frontend, so both reach translators through one Pontoon pipeline.
 *
 * `compileNamespace: 'ts'` makes `lingui compile` emit `messages.ts` beside each
 * `messages.po`. That is what the backend actually imports: Bun has no Vite, so
 * it cannot load a `.po` the way `src/i18n/index.ts` does. Both files are
 * committed — nothing in the backend's dev, build, or deploy path runs Lingui,
 * so a generated-but-ignored catalog would be a missing import on a fresh clone.
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
      path: '<rootDir>/src/emails/locales/{locale}/messages',
      include: ['src/emails'],
      exclude: ['**/*.test.*'],
    },
  ],
  compileNamespace: 'ts',
  // Same reasoning as the root config: line numbers would rewrite every catalog
  // whenever an `i18n._` call shifts a line, reddening the CI check for no
  // reason. (The root config says "macro" here; macros are banned in this
  // directory, so the trigger is the plain runtime call.)
  format: formatter({ lineNumbers: false }),
})
