/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * AI instructions for the map widget. Added to the widget system prompt so any
 * built-in agent can render locations on a map. (ACP pipelines that want to use
 * it emit the same tag from their own prompt.)
 */
export const instructions = `## Map
<widget:map data='<GeoJSON FeatureCollection as valid JSON>' title="Optional title" />
Renders locations on an interactive map. \`data\` MUST be a **valid GeoJSON FeatureCollection** — strict JSON with double-quoted keys and strings, wrapped in single quotes. Supports Point, LineString, and Polygon geometries (and their Multi* variants). Each feature's \`properties\` may include \`label\`, \`name\`, \`title\`, or \`description\`, which are shown in the popup.
Optional per-feature styling follows the simplestyle-spec: \`marker-color\`, \`marker-size\` (small | medium | large), \`stroke\`, \`stroke-width\`, \`fill\`, \`fill-opacity\`.
Example: <widget:map data='{"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"Point","coordinates":[-122.3321,47.6062]},"properties":{"label":"Seattle","description":"Home office"}}]}' />`
