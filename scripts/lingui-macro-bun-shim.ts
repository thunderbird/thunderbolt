/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Makes the Lingui macros importable under plain `bun run` (THU-812).
 *
 * The macros are compile-time only: Vite's Babel pass rewrites the calls and
 * deletes the import, so no shipped bundle ever loads them. Bun has no Babel
 * pass, so the import resolves to Lingui's stub, whose every export throws when
 * called — and a module-scope descriptor table (`src/lib/otp-error-messages.ts`)
 * is called at import time.
 *
 * The eval CLIs run under plain Bun and reach UI modules transitively: the
 * entrypoint imports the DAL, which re-exports the contexts barrel, which pulls
 * in components. So they need the same identity macros bun tests use, mapped
 * onto both macro specifiers. Preloaded via `--preload` on the `eval*` scripts.
 *
 * Bun tests get this from `mock.module` in `src/testing-library.ts` instead; a
 * `Bun.plugin` module override is the equivalent outside the test runner.
 */

import * as macros from '../src/i18n/identity-macros'

Bun.plugin({
  name: 'lingui-macro-identity',
  setup(build) {
    build.module('@lingui/react/macro', () => ({
      exports: { Trans: macros.Trans, Plural: macros.Plural, useLingui: macros.useLingui },
      loader: 'object',
    }))

    build.module('@lingui/core/macro', () => ({
      exports: { t: macros.t, plural: macros.plural, msg: macros.msg, defineMessage: macros.defineMessage },
      loader: 'object',
    }))

    // `src/i18n/index.ts` statically imports the compiled source catalog, which
    // only @lingui/vite-plugin knows how to produce. Same reasoning as the macros
    // above: plain Bun has no such loader, so without this the eval CLIs die at
    // import with "Export named 'messages' not found". They render no UI, so an
    // empty catalog costs them nothing.
    build.onLoad({ filter: /\.po$/ }, () => ({
      exports: { messages: {} },
      loader: 'object',
    }))
  },
})
