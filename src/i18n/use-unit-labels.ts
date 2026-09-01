/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getUnitLabels, type UnitLabels } from './unit-labels'
import { useActiveLocale } from './use-active-locale'

/**
 * Unit option labels bound to the active locale.
 *
 * Same reasoning as `useFormatters`: Lingui's `I18nProvider` re-renders only the
 * components that read its context, so a component that labels its options
 * without subscribing to the locale keeps rendering the outgoing language's
 * currency names after a switch.
 */
export const useUnitLabels = (): UnitLabels => getUnitLabels(useActiveLocale())
