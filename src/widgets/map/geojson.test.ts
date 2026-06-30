/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { featureBounds, featureLabel, parseFeatureCollection } from './geojson'

const point = (lng: number, lat: number, properties: Record<string, unknown> | null = null) => ({
  type: 'Feature' as const,
  geometry: { type: 'Point' as const, coordinates: [lng, lat] },
  properties,
})

const collection = (features: unknown[]) => JSON.stringify({ type: 'FeatureCollection', features })

describe('parseFeatureCollection', () => {
  test('parses a valid Point FeatureCollection', () => {
    const parsed = parseFeatureCollection(collection([point(-122.33, 47.61, { label: 'Seattle' })]))
    expect(parsed?.features).toHaveLength(1)
    expect(parsed?.features[0].geometry.type).toBe('Point')
  })

  test('parses LineString and Polygon geometries', () => {
    const parsed = parseFeatureCollection(
      collection([
        {
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [
              [0, 0],
              [1, 1],
            ],
          },
          properties: null,
        },
        {
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 0],
              ],
            ],
          },
          properties: null,
        },
      ]),
    )
    expect(parsed?.features.map((f) => f.geometry.type)).toEqual(['LineString', 'Polygon'])
  })

  test('parses Multi* geometries (MultiPoint / MultiLineString / MultiPolygon)', () => {
    const parsed = parseFeatureCollection(
      collection([
        {
          type: 'Feature',
          geometry: {
            type: 'MultiPoint',
            coordinates: [
              [0, 0],
              [1, 1],
            ],
          },
          properties: null,
        },
        {
          type: 'Feature',
          geometry: {
            type: 'MultiLineString',
            coordinates: [
              [
                [0, 0],
                [1, 1],
              ],
              [
                [2, 2],
                [3, 3],
              ],
            ],
          },
          properties: null,
        },
        {
          type: 'Feature',
          geometry: {
            type: 'MultiPolygon',
            coordinates: [
              [
                [
                  [0, 0],
                  [1, 0],
                  [1, 1],
                  [0, 0],
                ],
              ],
            ],
          },
          properties: null,
        },
      ]),
    )
    expect(parsed?.features.map((f) => f.geometry.type)).toEqual(['MultiPoint', 'MultiLineString', 'MultiPolygon'])
  })

  test('keeps unknown (domain-specific) properties via passthrough', () => {
    const parsed = parseFeatureCollection(collection([point(8.68, 50.11, { label: 'X', target_priority: 'high' })]))
    expect(parsed).not.toBeNull()
    // passthrough preserves the raw value, but the widget never reads it.
    expect((parsed?.features[0].properties as Record<string, unknown>).target_priority).toBe('high')
  })

  test('returns null for invalid JSON', () => {
    expect(parseFeatureCollection("{'type': 'FeatureCollection'}")).toBeNull() // single quotes = not JSON
    expect(parseFeatureCollection('not json')).toBeNull()
  })

  test('returns null for non-FeatureCollection or empty features', () => {
    expect(parseFeatureCollection(JSON.stringify({ type: 'Feature', geometry: null }))).toBeNull()
    expect(parseFeatureCollection(collection([]))).toBeNull() // min(1)
  })

  test('returns null for malformed coordinates', () => {
    expect(
      parseFeatureCollection(
        collection([{ type: 'Feature', geometry: { type: 'Point', coordinates: ['a', 'b'] }, properties: null }]),
      ),
    ).toBeNull()
  })
})

describe('featureLabel', () => {
  test('prefers label, then name, then title', () => {
    expect(featureLabel({ label: 'L', name: 'N', title: 'T' })).toBe('L')
    expect(featureLabel({ name: 'N', title: 'T' })).toBe('N')
    expect(featureLabel({ title: 'T' })).toBe('T')
  })

  test('ignores non-string and domain-specific fields, returns null when absent', () => {
    expect(featureLabel({ description: 'd', target_priority: 'high' })).toBeNull()
    expect(featureLabel({ label: 42 })).toBeNull()
    expect(featureLabel(null)).toBeNull()
  })
})

describe('featureBounds', () => {
  test('computes [[w,s],[e,n]] across points', () => {
    const parsed = parseFeatureCollection(collection([point(-122, 47), point(8, 50)]))
    expect(featureBounds(parsed!)).toEqual([
      [-122, 47],
      [8, 50],
    ])
  })

  test('walks Multi* nested coordinates for fit-bounds', () => {
    const parsed = parseFeatureCollection(
      collection([
        {
          type: 'Feature',
          geometry: {
            type: 'MultiPolygon',
            coordinates: [
              [
                [
                  [0, 0],
                  [4, 0],
                  [4, 3],
                  [0, 0],
                ],
              ],
            ],
          },
          properties: null,
        },
        {
          type: 'Feature',
          geometry: {
            type: 'MultiPoint',
            coordinates: [
              [-2, -1],
              [6, 5],
            ],
          },
          properties: null,
        },
      ]),
    )
    expect(featureBounds(parsed!)).toEqual([
      [-2, -1],
      [6, 5],
    ])
  })

  test('walks nested polygon coordinates', () => {
    const parsed = parseFeatureCollection(
      collection([
        {
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [0, 0],
                [4, 0],
                [4, 3],
                [0, 3],
                [0, 0],
              ],
            ],
          },
          properties: null,
        },
      ]),
    )
    expect(featureBounds(parsed!)).toEqual([
      [0, 0],
      [4, 3],
    ])
  })
})
