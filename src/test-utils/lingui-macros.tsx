/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Identity implementations of the Lingui macros for bun tests (THU-806).
 *
 * Bun's test runner transpiles TS/TSX natively and never runs Babel, so the
 * `@lingui/babel-plugin-lingui-macro` transform Vite applies at build time
 * does not happen here — the macro imports would hit runtime stubs that
 * throw. These equivalents render the English source text exactly as
 * written, so existing `getByText` assertions keep passing with no
 * I18nProvider or catalogs in the test tree.
 *
 * Registered globally via `mock.module` in `src/testing-library.ts` for both
 * `@lingui/react/macro` and `@lingui/core/macro`.
 *
 * `select` / `selectOrdinal` are intentionally NOT implemented: the
 * po-gettext catalog format cannot express them, so they are off-limits
 * codebase-wide — a test failing on a missing export is the desired signal.
 */

import { i18n } from '@lingui/core'
import type { ReactNode } from 'react'

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

/** Identity `useLingui`: the shared runtime i18n (activated as `en` in src/i18n) plus the identity `t`. */
export const useLingui = () => ({ t: identityT, i18n })
