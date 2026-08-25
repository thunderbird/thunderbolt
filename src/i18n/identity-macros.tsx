/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Identity implementations of the Lingui macros for code running under Bun
 * rather than Vite (THU-806).
 *
 * Bun transpiles TS/TSX natively and never runs Babel, so the
 * `@lingui/babel-plugin-lingui-macro` transform Vite applies at build time
 * does not happen here — the macro imports would hit runtime stubs that
 * throw. These equivalents render the English source text exactly as
 * written, so existing `getByText` assertions keep passing with no
 * I18nProvider or catalogs in the test tree.
 *
 * Two consumers register these for both `@lingui/react/macro` and
 * `@lingui/core/macro`: `src/testing-library.ts` via `mock.module` for bun
 * tests, and `scripts/lingui-macro-bun-shim.ts` via `Bun.plugin` for the
 * plain-Bun eval CLIs.
 *
 * `select` / `selectOrdinal` are intentionally NOT implemented: the
 * po-gettext catalog format cannot express them, so they are off-limits
 * codebase-wide — a test failing on a missing export is the desired signal.
 */

import { i18n } from '@lingui/core'
import type { ReactNode } from 'react'
import { sourceLocale } from '@shared/i18n/locales'

// `i18n._` throws without an active locale. Consumers of this module (bun tests,
// `bun run` entrypoints) may never import `src/i18n`, which is what activates the
// singleton in the browser — so activate it here for anything resolving a
// `msg` descriptor through the identity `useLingui`.
if (!i18n.locale) {
  i18n.loadAndActivate({ locale: sourceLocale, messages: {} })
}

const pluralRules = new Intl.PluralRules('en')

type PluralFormsBase<T> = {
  zero?: T
  one?: T
  two?: T
  few?: T
  many?: T
  other: T
}

/** Picks the English CLDR plural form, honouring exact `_N` overrides. */
const selectPluralForm = <T,>(value: number, forms: PluralFormsBase<T> & Record<string, T | undefined>): T => {
  const exact = forms[`_${value}`]
  if (exact !== undefined) {
    return exact
  }
  return forms[pluralRules.select(value)] ?? forms.other
}

const interpolateHash = (form: string, value: number): string => form.replaceAll('#', String(value))

/** Identity `<Trans>`: renders its children (the English source) untouched. */
export const Trans = ({ children }: { children?: ReactNode }) => <>{children}</>

type PluralProps = PluralFormsBase<ReactNode> & {
  value: number | string
} & Record<`_${number}`, ReactNode>

/** Identity `<Plural>`: selects the English form and substitutes `#`. */
export const Plural = ({ value, ...forms }: PluralProps) => {
  const count = Number(value)
  const form = selectPluralForm(count, forms as PluralFormsBase<ReactNode> & Record<string, ReactNode>)
  return <>{typeof form === 'string' ? interpolateHash(form, count) : form}</>
}

/** Identity `t` tagged template: plain template-string interpolation. */
const identityT = (strings: TemplateStringsArray, ...values: unknown[]): string =>
  strings.reduce((acc, part, index) => acc + part + (index < values.length ? String(values[index]) : ''), '')

/** Identity `plural(...)` expression: English form with `#` substituted. */
export const plural = (value: number, forms: PluralFormsBase<string> & Record<string, string | undefined>): string =>
  interpolateHash(selectPluralForm(value, forms), value)

export const t = identityT

/** Identity `msg`/`defineMessage`: the interpolated English string (real `i18n._` echoes string ids back). */
export const msg = identityT
export const defineMessage = identityT

/** Identity `useLingui`: the shared runtime i18n (activated above) plus the identity `t`. */
export const useLingui = () => ({ t: identityT, i18n })
