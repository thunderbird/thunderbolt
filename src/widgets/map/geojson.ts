/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isRecord } from '@/lib/utils'
import { z } from 'zod'

/**
 * Minimal, neutral GeoJSON schema for the map widget. We validate the standard
 * geometry shapes and read only generic display fields off `properties`
 * (`label` / `name` / `title` / `description`). Any other properties pass
 * through validation but are intentionally never rendered — the widget is a
 * generic location renderer, not a domain-specific visualizer.
 */

/** `[longitude, latitude]` with an optional trailing altitude. */
const position = z.tuple([z.number(), z.number()]).rest(z.number())

const geometry = z.discriminatedUnion('type', [
  z.object({ type: z.literal('Point'), coordinates: position }),
  z.object({ type: z.literal('MultiPoint'), coordinates: z.array(position) }),
  z.object({ type: z.literal('LineString'), coordinates: z.array(position) }),
  z.object({ type: z.literal('MultiLineString'), coordinates: z.array(z.array(position)) }),
  z.object({ type: z.literal('Polygon'), coordinates: z.array(z.array(position)) }),
  z.object({ type: z.literal('MultiPolygon'), coordinates: z.array(z.array(z.array(position))) }),
])

/** Only generic display fields are typed; `.passthrough()` tolerates (but the
 *  widget ignores) any domain-specific properties on a feature. */
const featureProperties = z
  .object({
    label: z.string().optional(),
    name: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
  })
  .passthrough()
  .nullable()

const feature = z.object({
  type: z.literal('Feature'),
  geometry,
  properties: featureProperties,
})

export const featureCollectionSchema = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(feature).min(1),
})

export type MapFeatureCollection = z.infer<typeof featureCollectionSchema>
export type MapFeature = z.infer<typeof feature>
export type MapFeatureProperties = z.infer<typeof featureProperties>

const geometryTypeNames = ['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'] as const

/**
 * Rewrite a geometry that names its type as a key (`{"Point":"","coordinates":[…]}`)
 * into the GeoJSON shape (`{"type":"Point","coordinates":[…]}`). Models, DeepSeek
 * in particular, emit the first form inside an otherwise valid collection.
 * The repaired name is applied last so a non-string `type` already on the object
 * cannot replace it.
 */
const normalizeGeometry = (geometry: unknown): unknown => {
  if (!isRecord(geometry) || typeof geometry.type === 'string') {
    return geometry
  }
  const typeName = geometryTypeNames.find((name) => Object.hasOwn(geometry, name))
  if (!typeName) {
    return geometry
  }
  const { [typeName]: _dropped, ...rest } = geometry
  return { ...rest, type: typeName }
}

/**
 * Parse a GeoJSON FeatureCollection, or null when nothing in it can be drawn.
 * A feature that fails validation is dropped so one bad pin does not discard
 * the rest of the map. An empty result is null — the widget must not render
 * a blank map.
 */
export const parseFeatureCollection = (raw: string): MapFeatureCollection | null => {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(json) || json.type !== 'FeatureCollection' || !Array.isArray(json.features)) {
    return null
  }

  const features = json.features.flatMap((item) => {
    const candidate = isRecord(item) ? { ...item, geometry: normalizeGeometry(item.geometry) } : item
    const parsed = feature.safeParse(candidate)
    return parsed.success ? [parsed.data] : []
  })
  if (features.length === 0) {
    return null
  }
  return { type: 'FeatureCollection', features }
}

/**
 * The neutral display label for a feature: first of `label` / `name` / `title`,
 * else null. Deliberately limited to generic fields — domain-specific
 * properties are never surfaced. Accepts a loose record so it works for both
 * the zod-parsed properties and MapLibre's runtime feature properties.
 */
export const featureLabel = (properties: Record<string, unknown> | null | undefined): string | null => {
  const pick = (key: string): string | null =>
    typeof properties?.[key] === 'string' ? (properties[key] as string) : null
  return pick('label') ?? pick('name') ?? pick('title')
}

/**
 * Bounding box `[[west, south], [east, north]]` over every coordinate in the
 * collection, or null if it has none. Walks nested coordinate arrays so it
 * handles points, lines, and polygons uniformly.
 */
export const featureBounds = (collection: MapFeatureCollection): [[number, number], [number, number]] | null => {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let found = false

  const walk = (node: unknown): void => {
    if (Array.isArray(node) && typeof node[0] === 'number' && typeof node[1] === 'number') {
      const [x, y] = node as [number, number]
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
      found = true
      return
    }
    if (Array.isArray(node)) {
      node.forEach(walk)
    }
  }

  for (const f of collection.features) {
    walk(f.geometry.coordinates)
  }
  return found
    ? [
        [minX, minY],
        [maxX, maxY],
      ]
    : null
}
