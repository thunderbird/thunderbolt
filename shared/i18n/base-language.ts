/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The base language subtag of a BCP-47 tag: `pt-BR` → `pt`, `en-XA` → `en`.
 *
 * External services we hand the app language to generally take a bare
 * two-letter code rather than a full tag — Open-Meteo's geocoding `language`
 * parameter is the case in point, where `pt-BR` returns nothing.
 *
 * Expects a well-formed tag (`Intl.Locale` throws otherwise); both callers pass
 * an already-validated locale from the shipped set.
 *
 * @param tag A well-formed BCP-47 language tag.
 * @returns The base language subtag.
 */
export const baseLanguage = (tag: string): string => new Intl.Locale(tag).language
