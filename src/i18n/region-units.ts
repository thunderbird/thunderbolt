/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export type DistanceUnit = 'metric' | 'imperial'
export type TemperatureUnit = 'c' | 'f'
export type TimeFormat = '12h' | '24h'

export type RegionUnitDefaults = {
  distanceUnit: DistanceUnit
  temperatureUnit: TemperatureUnit
  timeFormat: TimeFormat
  currency: string
}

/** Region used whenever we can't resolve one — matches the pre-THU-810 fallback. */
const fallbackRegion = 'US'

/**
 * CLDR `measurementSystem`: `US` (US, LR) and `UK` (GB, MM), everything else
 * metric. Both non-metric systems collapse to `imperial` here because this
 * setting is specifically *distance*, and the UK and Myanmar both post road
 * distances in miles.
 */
const imperialRegions = new Set(['US', 'LR', 'GB', 'MM'])

/**
 * CLDR `measurementSystem-category-temperature`. A separate list from the one
 * above, not a subset of it: the UK is metric for temperature, and CLDR
 * explicitly overrides Liberia and Myanmar back to Celsius even though their
 * measurement system is US/UK.
 */
const fahrenheitRegions = new Set(['US', 'BS', 'BZ', 'KY', 'PR', 'PW'])

/**
 * Region → the ISO 4217 code to *default* to, transcribed from CLDR
 * `supplemental/currencyData.json` (`region`, keeping only entries with no
 * `_to` end date and no `_tender: false`).
 *
 * Where CLDR lists two current tenders for a region this picks the one in
 * everyday use — Panama and Zimbabwe transact in USD, Namibia in ZAR, Bhutan in
 * INR — so the other is absent here. That is why the picker's option list is not
 * derived from these values alone: see `additionalTenders`.
 */
const currencyByRegion: Record<string, string> = {
  AC: 'SHP',
  AD: 'EUR',
  AE: 'AED',
  AF: 'AFN',
  AG: 'XCD',
  AI: 'XCD',
  AL: 'ALL',
  AM: 'AMD',
  AO: 'AOA',
  AR: 'ARS',
  AS: 'USD',
  AT: 'EUR',
  AU: 'AUD',
  AW: 'AWG',
  AX: 'EUR',
  AZ: 'AZN',
  BA: 'BAM',
  BB: 'BBD',
  BD: 'BDT',
  BE: 'EUR',
  BF: 'XOF',
  BG: 'EUR',
  BH: 'BHD',
  BI: 'BIF',
  BJ: 'XOF',
  BL: 'EUR',
  BM: 'BMD',
  BN: 'BND',
  BO: 'BOB',
  BQ: 'USD',
  BR: 'BRL',
  BS: 'BSD',
  BT: 'INR',
  BV: 'NOK',
  BW: 'BWP',
  BY: 'BYN',
  BZ: 'BZD',
  CA: 'CAD',
  CC: 'AUD',
  CD: 'CDF',
  CF: 'XAF',
  CG: 'XAF',
  CH: 'CHF',
  CI: 'XOF',
  CK: 'NZD',
  CL: 'CLP',
  CM: 'XAF',
  CN: 'CNY',
  CO: 'COP',
  CR: 'CRC',
  CU: 'CUP',
  CV: 'CVE',
  CW: 'XCG',
  CX: 'AUD',
  CY: 'EUR',
  CZ: 'CZK',
  DE: 'EUR',
  DG: 'USD',
  DJ: 'DJF',
  DK: 'DKK',
  DM: 'XCD',
  DO: 'DOP',
  DZ: 'DZD',
  EA: 'EUR',
  EC: 'USD',
  EE: 'EUR',
  EG: 'EGP',
  EH: 'MAD',
  ER: 'ERN',
  ES: 'EUR',
  ET: 'ETB',
  EU: 'EUR',
  FI: 'EUR',
  FJ: 'FJD',
  FK: 'FKP',
  FM: 'USD',
  FO: 'DKK',
  FR: 'EUR',
  GA: 'XAF',
  GB: 'GBP',
  GD: 'XCD',
  GE: 'GEL',
  GF: 'EUR',
  GG: 'GBP',
  GH: 'GHS',
  GI: 'GIP',
  GL: 'DKK',
  GM: 'GMD',
  GN: 'GNF',
  GP: 'EUR',
  GQ: 'XAF',
  GR: 'EUR',
  GS: 'GBP',
  GT: 'GTQ',
  GU: 'USD',
  GW: 'XOF',
  GY: 'GYD',
  HK: 'HKD',
  HM: 'AUD',
  HN: 'HNL',
  HR: 'EUR',
  HT: 'USD',
  HU: 'HUF',
  IC: 'EUR',
  ID: 'IDR',
  IE: 'EUR',
  IL: 'ILS',
  IM: 'GBP',
  IN: 'INR',
  IO: 'USD',
  IQ: 'IQD',
  IR: 'IRR',
  IS: 'ISK',
  IT: 'EUR',
  JE: 'GBP',
  JM: 'JMD',
  JO: 'JOD',
  JP: 'JPY',
  KE: 'KES',
  KG: 'KGS',
  KH: 'KHR',
  KI: 'AUD',
  KM: 'KMF',
  KN: 'XCD',
  KP: 'KPW',
  KR: 'KRW',
  KW: 'KWD',
  KY: 'KYD',
  KZ: 'KZT',
  LA: 'LAK',
  LB: 'LBP',
  LC: 'XCD',
  LI: 'CHF',
  LK: 'LKR',
  LR: 'LRD',
  LS: 'LSL',
  LT: 'EUR',
  LU: 'EUR',
  LV: 'EUR',
  LY: 'LYD',
  MA: 'MAD',
  MC: 'EUR',
  MD: 'MDL',
  ME: 'EUR',
  MF: 'EUR',
  MG: 'MGA',
  MH: 'USD',
  MK: 'MKD',
  ML: 'XOF',
  MM: 'MMK',
  MN: 'MNT',
  MO: 'MOP',
  MP: 'USD',
  MQ: 'EUR',
  MR: 'MRU',
  MS: 'XCD',
  MT: 'EUR',
  MU: 'MUR',
  MV: 'MVR',
  MW: 'MWK',
  MX: 'MXN',
  MY: 'MYR',
  MZ: 'MZN',
  NA: 'ZAR',
  NC: 'XPF',
  NE: 'XOF',
  NF: 'AUD',
  NG: 'NGN',
  NI: 'NIO',
  NL: 'EUR',
  NO: 'NOK',
  NP: 'NPR',
  NR: 'AUD',
  NU: 'NZD',
  NZ: 'NZD',
  OM: 'OMR',
  PA: 'USD',
  PE: 'PEN',
  PF: 'XPF',
  PG: 'PGK',
  PH: 'PHP',
  PK: 'PKR',
  PL: 'PLN',
  PM: 'EUR',
  PN: 'NZD',
  PR: 'USD',
  PS: 'JOD',
  PT: 'EUR',
  PW: 'USD',
  PY: 'PYG',
  QA: 'QAR',
  RE: 'EUR',
  RO: 'RON',
  RS: 'RSD',
  RU: 'RUB',
  RW: 'RWF',
  SA: 'SAR',
  SB: 'SBD',
  SC: 'SCR',
  SD: 'SDG',
  SE: 'SEK',
  SG: 'SGD',
  SH: 'SHP',
  SI: 'EUR',
  SJ: 'NOK',
  SK: 'EUR',
  SL: 'SLE',
  SM: 'EUR',
  SN: 'XOF',
  SO: 'SOS',
  SR: 'SRD',
  SS: 'SSP',
  ST: 'STN',
  SV: 'USD',
  SX: 'XCG',
  SY: 'SYP',
  SZ: 'SZL',
  TA: 'GBP',
  TC: 'USD',
  TD: 'XAF',
  TF: 'EUR',
  TG: 'XOF',
  TH: 'THB',
  TJ: 'TJS',
  TK: 'NZD',
  TL: 'USD',
  TM: 'TMT',
  TN: 'TND',
  TO: 'TOP',
  TR: 'TRY',
  TT: 'TTD',
  TV: 'AUD',
  TW: 'TWD',
  TZ: 'TZS',
  UA: 'UAH',
  UG: 'UGX',
  UM: 'USD',
  US: 'USD',
  UY: 'UYU',
  UZ: 'UZS',
  VA: 'EUR',
  VC: 'XCD',
  VE: 'VES',
  VG: 'USD',
  VI: 'USD',
  VN: 'VND',
  VU: 'VUV',
  WF: 'XPF',
  WS: 'WST',
  XK: 'EUR',
  YE: 'YER',
  YT: 'EUR',
  ZA: 'ZAR',
  ZM: 'ZMW',
  ZW: 'USD',
}

/**
 * The BCP-47 tag whose conventions a region follows, built from CLDR likely
 * subtags: `BR` → `pt-BR`, `GB` → `en-GB`.
 *
 * The script subtag is deliberately dropped. ICU keys its hour-cycle data on
 * `language-REGION`, so a maximized tag falls off the lookup path and silently
 * resolves to the root default: `en-GB` is `h23` but `en-Latn-GB` is `h12`, and
 * `es-MX` is `h12` but `es-Latn-MX` is `h23`.
 */
const tagForRegion = (region: string): string => {
  const { language } = new Intl.Locale(`und-${region}`).maximize()
  return new Intl.Locale(language, { region }).toString()
}

const timeFormatForRegion = (region: string): TimeFormat => {
  const { hourCycle } = new Intl.DateTimeFormat(tagForRegion(region), { hour: 'numeric' }).resolvedOptions()
  return hourCycle === 'h11' || hourCycle === 'h12' ? '12h' : '24h'
}

/**
 * Legal tender somewhere, but not the default for any region above. Without
 * these the picker cannot offer a Bhutanese user the ngultrum or a Namibian the
 * Namibian dollar — their own currency would be missing from the list entirely,
 * with no way to correct the default.
 *
 * Filtered by what the runtime can actually name. ZWG (Zimbabwe Gold, introduced
 * 2024) is absent from older ICU builds, where `Intl.DisplayNames` echoes the raw
 * code back — an option reading "ZWG · ZWG" is worse than no option. Every region
 * default above predates that cutoff, so only the extras need the guard.
 */
const supportedCurrencies = new Set(Intl.supportedValuesOf('currency'))

const additionalTenders = ['BTN', 'HTG', 'NAD', 'PAB', 'ZWG'].filter((code) => supportedCurrencies.has(code))

/** Every currency in circulation, for the currency picker. */
export const activeCurrencyCodes: readonly string[] = [
  ...new Set([...Object.values(currencyByRegion), ...additionalTenders]),
].sort()

/**
 * The unit conventions of an ISO 3166-1 alpha-2 region. Unknown regions fall
 * back to `US`, which is what the retired `/units` endpoint did.
 */
export const unitDefaultsForRegion = (region: string): RegionUnitDefaults => {
  const code = region.toUpperCase()
  const resolved = currencyByRegion[code] ? code : fallbackRegion
  return {
    distanceUnit: imperialRegions.has(resolved) ? 'imperial' : 'metric',
    temperatureUnit: fahrenheitRegions.has(resolved) ? 'f' : 'c',
    timeFormat: timeFormatForRegion(resolved),
    currency: currencyByRegion[resolved],
  }
}
