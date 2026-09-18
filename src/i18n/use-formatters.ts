/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getFormatters, type Formatters } from './format'
import { useActiveLocale } from './use-active-locale'

/**
 * The formatting functions bound to the active locale.
 *
 * Use this rather than `getFormatters(getActiveLocale())` in components.
 * Lingui's `I18nProvider` re-renders only the components that read its context,
 * so a component that formats without subscribing to the locale keeps rendering
 * the outgoing locale's dates and numbers after a language switch.
 */
export const useFormatters = (): Formatters => getFormatters(useActiveLocale())
