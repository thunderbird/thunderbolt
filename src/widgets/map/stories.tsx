/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Meta, StoryObj } from '@storybook/react-vite'
import { MapWidget } from './widget'

const mixedGeometries = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [8.6821, 50.1109] },
      properties: { label: 'Frankfurt' },
    },
    {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [8.66, 50.1],
          [8.7, 50.12],
          [8.74, 50.1],
        ],
      },
      properties: { label: 'Route' },
    },
    {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [8.66, 50.09],
            [8.74, 50.09],
            [8.74, 50.13],
            [8.66, 50.13],
            [8.66, 50.09],
          ],
        ],
      },
      properties: { label: 'Area of interest' },
    },
  ],
})

const meta = {
  title: 'widgets/map',
  component: MapWidget,
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MapWidget>

export default meta
type Story = StoryObj<typeof meta>

export const Points: Story = {
  args: {
    data: '{"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"Point","coordinates":[-122.3321,47.6062]},"properties":{"label":"Seattle","description":"Click a marker to see its popup."}},{"type":"Feature","geometry":{"type":"Point","coordinates":[-122.6765,45.5231]},"properties":{"label":"Portland"}}]}',
    title: 'Office locations',
  },
}

export const MixedGeometries: Story = { args: { data: mixedGeometries, title: 'Point, line, and polygon' } }

// Per-feature styling via the generic simplestyle-spec keys (marker-color,
// marker-size, stroke, fill). No domain-specific properties involved.
const styled = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-0.1276, 51.5072] },
      properties: { label: 'London', 'marker-color': '#16a34a', 'marker-size': 'large' },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [2.3522, 48.8566] },
      properties: { label: 'Paris', 'marker-color': '#dc2626', 'marker-size': 'small' },
    },
    {
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [-0.1276, 51.5072],
          [2.3522, 48.8566],
        ],
      },
      properties: { label: 'Leg', stroke: '#f59e0b', 'stroke-width': 3 },
    },
  ],
})

export const Styled: Story = { args: { data: styled, title: 'Per-feature simplestyle styling' } }
