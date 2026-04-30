/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export { WeatherForecast } from './display'
export { instructions } from './instructions'
export {
  convertTemperature,
  getWeatherMetadata,
  WeatherForecastDataSchema,
  type WeatherDay,
  type WeatherForecastData,
  type WeatherMetadata,
} from './lib'
export { parse, schema } from './schema'
export type { CacheData, WeatherForecastWidget as WeatherForecastWidgetType } from './schema'
export { WeatherForecastWidget, WeatherForecastWidget as Component } from './widget'
