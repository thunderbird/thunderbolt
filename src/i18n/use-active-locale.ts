/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AppLocale } from '@shared/i18n/locales'
import { useSyncExternalStore } from 'react'
import { getActiveLocale, subscribeActiveLocale } from './active-locale'

/**
 * The active locale, as a reactive value.
 *
 * Use this — not a bare `getActiveLocale()` — anywhere a render depends on the
 * locale, such as a TanStack Query key for a response that varies by language.
 * A plain read would only happen to be correct when some ancestor re-rendered
 * for an unrelated reason.
 */
export const useActiveLocale = (): AppLocale =>
  useSyncExternalStore(subscribeActiveLocale, getActiveLocale, getActiveLocale)
