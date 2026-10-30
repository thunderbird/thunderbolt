/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createParser } from '@/lib/create-parser'
import { z } from 'zod'
import { parseFeatureCollection } from './geojson'

/**
 * Zod schema for the map widget. `data` carries a GeoJSON FeatureCollection as
 * a JSON string (kept as a string in args — the same pattern as the citation
 * widget's `sources`); the `.refine` rejects a payload with no drawable
 * feature so a malformed tag never renders an empty map. One invalid feature
 * does not fail the tag — `parseFeatureCollection` drops it and keeps the rest.
 * Parsing into the typed collection happens in the component.
 */
export const schema = z.object({
  widget: z.literal('map'),
  args: z.object({
    data: z
      .string()
      .min(1, 'GeoJSON data is required')
      .refine((value) => parseFeatureCollection(value) !== null, 'Invalid GeoJSON: must be a valid FeatureCollection'),
    title: z.string().optional(),
  }),
})

export type MapWidget = z.infer<typeof schema>

/** Parse function — auto-generated from schema. */
export const parse = createParser(schema)
