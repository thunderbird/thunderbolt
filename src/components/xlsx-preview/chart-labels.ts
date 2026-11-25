/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import type { ChartKind, PlaceholderKind } from '@/office/xlsx-drawings'

/** The name of each chart type, used in a drawn chart's accessible name and in a placeholder's label. */
export const chartKindLabels = {
  column: msg`Column chart`,
  bar: msg`Bar chart`,
  line: msg`Line chart`,
  area: msg`Area chart`,
  pie: msg`Pie chart`,
  doughnut: msg`Doughnut chart`,
  scatter: msg`Scatter chart`,
  radar: msg`Radar chart`,
  bubble: msg`Bubble chart`,
  stock: msg`Stock chart`,
  surface: msg`Surface chart`,
  pieOfPie: msg`Pie of pie chart`,
  threeD: msg`3-D chart`,
  stackedLine: msg`Stacked line chart`,
  stackedArea: msg`Stacked area chart`,
  combination: msg`Combination chart`,
  waterfall: msg`Waterfall chart`,
  treemap: msg`Treemap chart`,
  sunburst: msg`Sunburst chart`,
  funnel: msg`Funnel chart`,
  boxWhisker: msg`Box and whisker chart`,
  histogram: msg`Histogram chart`,
  pareto: msg`Pareto chart`,
  regionMap: msg`Map chart`,
  other: msg`Chart`,
} satisfies Record<ChartKind | PlaceholderKind, MessageDescriptor>
