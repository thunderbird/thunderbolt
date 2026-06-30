/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export {
  featureBounds,
  featureCollectionSchema,
  featureLabel,
  parseFeatureCollection,
  type MapFeature,
  type MapFeatureCollection,
} from './geojson'
export { instructions } from './instructions'
export { parse, schema, type MapWidget as MapWidgetType } from './schema'
export { MapSkeleton, MapWidget, MapWidget as Component, MapWidgetSkeleton as Skeleton } from './widget'
