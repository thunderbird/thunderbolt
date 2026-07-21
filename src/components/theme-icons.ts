/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Monitor, Moon, Sun } from 'lucide-react'

import type { Theme } from '@/lib/theme-provider'

/** One icon per theme setting — the single source shared by the dev-only
 *  cycling toggle and the Preferences three-way picker. */
export const themeIcons: Record<Theme, typeof Sun> = { light: Sun, dark: Moon, system: Monitor }

/** Narrows a ToggleGroup/select string to a {@link Theme}. */
export const isTheme = (value: string): value is Theme => value in themeIcons
