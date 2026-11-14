/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DOMParser, type Element } from '@xmldom/xmldom'
import { strFromU8 } from 'fflate'
import { xlsxPreviewLimits } from './constants'
import { decodeXml, resolvePart, type WorkbookParts } from './formula-cache'
import { WorkbookTooLargeError } from './xlsx-preview-client'

const ns = {
  xdr: 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  c: 'http://schemas.openxmlformats.org/drawingml/2006/chart',
  cx: 'http://schemas.microsoft.com/office/drawing/2014/chartex',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
}

const drawnKinds = ['column', 'bar', 'line', 'area', 'pie', 'doughnut'] as const

/** The chart types the preview draws as SVG. */
export type ChartKind = (typeof drawnKinds)[number]

/** The chart types that get a placeholder naming them, Excel 2016's (waterfall, treemap, …) among them. */
export type PlaceholderKind =
  | 'scatter'
  | 'radar'
  | 'bubble'
  | 'stock'
  | 'surface'
  | 'pieOfPie'
  | 'threeD'
  | 'stackedLine'
  | 'stackedArea'
  | 'combination'
  | 'waterfall'
  | 'treemap'
  | 'sunburst'
  | 'funnel'
  | 'boxWhisker'
  | 'histogram'
  | 'pareto'
  | 'regionMap'
  | 'other'

/** How a bar or column chart puts its series side by side, on top of each other, or on top of each other as shares. */
export type Stacking = 'none' | 'stacked' | 'percent'

/** A cell and an offset into it, in EMU, as a drawing anchors a corner. */
type CellPoint = { col: number; colOff: number; row: number; rowOff: number }

/** Where an object sits: its top-left corner, and either its bottom-right corner or its size in EMU. */
export type Anchor = { from: CellPoint; to?: CellPoint; size?: { cx: number; cy: number } }

/** Values a chart saved, as the file holds them: the count it gives and each point by its index. */
type SavedPoints = { count: number; points: [number, string][] }

/** A series' name, values or categories: the range it reads, and the values the chart saved, if it saved any. */
export type SeriesData = { ref?: string; cache?: SavedPoints }

type ChartSeries = { name: SeriesData; values: SeriesData; categories: SeriesData }

type DrawingContent =
  | { type: 'chart'; kind: ChartKind; stacking: Stacking; title: string; series: ChartSeries[] }
  | { type: 'placeholder'; kind: PlaceholderKind; title: string }
  | { type: 'image'; bytes: Uint8Array; alt: string }
  | { type: 'shape' }

export type DrawingObject = DrawingContent & { anchor: Anchor }

const childElements = (parent: Element | undefined) => [...(parent?.children ?? [])]

const first = (parent: Element | undefined, namespace: string, name: string): Element | undefined =>
  parent?.getElementsByTagNameNS(namespace, name)[0]

const child = (parent: Element | undefined, name: string) => childElements(parent).find((el) => el.localName === name)

const numberIn = (parent: Element | undefined, name: string) => Number(child(parent, name)?.textContent) || 0

const pointOf = (el: Element | undefined): CellPoint => ({
  col: numberIn(el, 'col'),
  colOff: numberIn(el, 'colOff'),
  row: numberIn(el, 'row'),
  rowOff: numberIn(el, 'rowOff'),
})

/** A two-cell, one-cell or absolute anchor. An absolute one is placed as an offset from A1. */
const anchorOf = (el: Element): Anchor => {
  const ext = child(el, 'ext')
  const size = ext && { cx: Number(ext.getAttribute('cx')) || 0, cy: Number(ext.getAttribute('cy')) || 0 }
  if (el.localName === 'absoluteAnchor') {
    const pos = child(el, 'pos')
    const from = {
      col: 0,
      colOff: Number(pos?.getAttribute('x')) || 0,
      row: 0,
      rowOff: Number(pos?.getAttribute('y')) || 0,
    }
    return { from, size }
  }
  return {
    from: pointOf(child(el, 'from')),
    to: el.localName === 'twoCellAnchor' ? pointOf(child(el, 'to')) : undefined,
    size,
  }
}

const stackingOf = (group: Element): Stacking => {
  const grouping = child(group, 'grouping')?.getAttribute('val')
  return grouping === 'stacked' ? 'stacked' : grouping === 'percentStacked' ? 'percent' : 'none'
}

/** The kind of chart a plot area group draws, by its element name. Stacked lines and areas are not drawn. */
const kindOf = (group: Element): ChartKind | PlaceholderKind => {
  const stacked = stackingOf(group) !== 'none'
  switch (group.localName) {
    case 'barChart':
      return child(group, 'barDir')?.getAttribute('val') === 'bar' ? 'bar' : 'column'
    case 'lineChart':
      return stacked ? 'stackedLine' : 'line'
    case 'areaChart':
      return stacked ? 'stackedArea' : 'area'
    case 'pieChart':
      return 'pie'
    case 'doughnutChart':
      return 'doughnut'
    case 'scatterChart':
      return 'scatter'
    case 'radarChart':
      return 'radar'
    case 'bubbleChart':
      return 'bubble'
    case 'stockChart':
      return 'stock'
    case 'surfaceChart':
    case 'surface3DChart':
      return 'surface'
    case 'ofPieChart':
      return 'pieOfPie'
    case 'bar3DChart':
    case 'line3DChart':
    case 'area3DChart':
    case 'pie3DChart':
      return 'threeD'
    default:
      return 'other'
  }
}

/** An Excel 2016 chart's type, from the layouts its series name: a Pareto chart is a histogram plus a Pareto line. */
const chartExKind = (root: Element | undefined): PlaceholderKind => {
  const layouts = [...(root?.getElementsByTagNameNS(ns.cx, 'series') ?? [])].map((s) => s.getAttribute('layoutId'))
  switch (layouts.includes('paretoLine') ? 'paretoLine' : layouts[0]) {
    case 'waterfall':
      return 'waterfall'
    case 'treemap':
      return 'treemap'
    case 'sunburst':
      return 'sunburst'
    case 'funnel':
      return 'funnel'
    case 'boxWhisker':
      return 'boxWhisker'
    case 'clusteredColumn':
      return 'histogram'
    case 'paretoLine':
      return 'pareto'
    case 'regionMap':
      return 'regionMap'
    default:
      return 'other'
  }
}

const isDrawn = (kind: ChartKind | PlaceholderKind): kind is ChartKind => drawnKinds.some((drawn) => drawn === kind)

/**
 * The points a chart saved for a series part, or `undefined` when it saved none. They stay sparse, as the file
 * holds them: the count and indexes can say millions, so a list is built only when a chart draws them.
 */
const cachedPoints = (el: Element | undefined): SavedPoints | undefined => {
  const points = [...(el?.getElementsByTagNameNS(ns.c, 'pt') ?? [])].flatMap((point): [number, string][] => {
    const index = Number(point.getAttribute('idx'))
    return Number.isInteger(index) && index >= 0 ? [[index, first(point, ns.c, 'v')?.textContent ?? '']] : []
  })
  if (points.length === 0) {
    return undefined
  }
  const declared = Number(first(el, ns.c, 'ptCount')?.getAttribute('val')) || points.length
  const last = points.reduce((highest, [index]) => Math.max(highest, index), 0)
  return { count: Math.min(declared, last + 1), points }
}

/** The first `count` values of saved points, by index; a point the file left out is empty. */
export const expandPoints = ({ count: saved, points }: SavedPoints, count: number) => {
  const values = Array.from({ length: Math.min(saved, count) }, () => '')
  for (const [index, value] of points) {
    if (index < values.length) {
      values[index] = value
    }
  }
  return values
}

const seriesData = (el: Element | undefined): SeriesData => {
  const literal = child(el, 'v')?.textContent
  return {
    ref: first(el, ns.c, 'f')?.textContent ?? undefined,
    cache: cachedPoints(el) ?? (literal ? { count: 1, points: [[0, literal]] } : undefined),
  }
}

/** The chart's own title: its text runs, or the text a title that reads a cell saved. */
const titleOf = (chart: Element | undefined) => {
  const title = child(chart, 'title')
  const runs = [...(title?.getElementsByTagNameNS(ns.a, 't') ?? [])].map((t) => t.textContent ?? '')
  return (runs.length > 0 ? runs : (cachedPoints(title)?.points.map(([, text]) => text) ?? [])).join('')
}

type ChartContent = Extract<DrawingContent, { type: 'chart' | 'placeholder' }>

/** A drawing or chart part as a DOM. One past the size xmldom can hold in memory is refused before it is parsed. */
const parseXml = (xml: Uint8Array) => {
  if (xml.length > xlsxPreviewLimits.xmlPartBytes) {
    throw new WorkbookTooLargeError(`A part of ${xml.length} bytes is larger than the preview parses.`)
  }
  return new DOMParser().parseFromString(strFromU8(xml), 'text/xml').documentElement ?? undefined
}

/**
 * Comments, CDATA sections, processing instructions and any other `<!` (a directive such as `<!DOCTYPE`,
 * `<!ENTITY` or `<!_`): what a raw scan must not read as elements.
 */
const markupPattern = /<(?:!--|!\[CDATA\[|\?|!)/g

/**
 * A tag's attribute text, read as an XML parser reads it: a `>` inside a quoted value does not end the tag. A value
 * cannot hold `<`, so a pattern built on this never runs past the next tag and stays linear.
 */
export const attributeText = String.raw`(?:[^<>"']|"[^"<]*"|'[^'<]*')*`

const escapeText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * A part's text as the raw scans may read it, in one forward pass that stays linear: comments and processing
 * instructions taken out, and each CDATA section's body turned into escaped text, so a `<!--` or a `<row>` written
 * inside one is the text Excelize reads, not markup. A section left open runs to the end of the part, as in XML. A
 * directive is refused, in any case: Excelize's XML parser skips one to its closing `>`, quotes included, and the
 * preview reads no DTD, so it could not tell where Excelize would resume.
 */
export const scannableXml = (xml: string) => {
  if (!xml.includes('<!') && !xml.includes('<?')) {
    return xml
  }
  const kept: string[] = []
  const pattern = new RegExp(markupPattern)
  let at = 0
  while (at < xml.length) {
    pattern.lastIndex = at
    const found = pattern.exec(xml)
    if (!found) {
      kept.push(xml.slice(at))
      break
    }
    kept.push(xml.slice(at, found.index))
    const [opener] = found
    if (opener === '<!') {
      throw new Error('A part of the workbook holds a DOCTYPE or another directive, which the preview does not read.')
    }
    const closer = opener === '<!--' ? '-->' : opener === '<?' ? '?>' : ']]>'
    const bodyStart = found.index + opener.length
    const close = xml.indexOf(closer, bodyStart)
    const end = close === -1 ? xml.length : close
    if (opener === '<![CDATA[') {
      kept.push(escapeText(xml.slice(bodyStart, end)))
    }
    at = close === -1 ? xml.length : close + closer.length
  }
  return kept.join('')
}

/**
 * A tag name's optional namespace prefix for the scans' patterns: any run of characters but whitespace and
 * `<>/:!?="'`, then a colon, so a Unicode prefix such as `é:` matches as Go's encoding/xml reads it.
 */
export const namePrefix = String.raw`(?:[^\s<>/:!?="']+:)?`

/** An attribute as Go's encoding/xml reads it: its prefix, empty when it has none, its local name and decoded value. */
export type XmlAttribute = { prefix: string; local: string; value: string }

const isSpace = (char: string) => char === ' ' || char === '\t' || char === '\n' || char === '\r'

/** A qualified name split as Go splits it: on its one colon, when both sides are there; otherwise it is all local. */
const splitName = (name: string) => {
  const colon = name.indexOf(':')
  return colon > 0 && colon < name.length - 1 && name.indexOf(':', colon + 1) === -1
    ? { prefix: name.slice(0, colon), local: name.slice(colon + 1) }
    : { prefix: '', local: name }
}

/**
 * The attributes of a tag, in order, from the text between its name and its `>`: a character loop, so it stays
 * linear and has no length limit, which a pattern over megabytes of attribute text does not in JavaScriptCore. A
 * value is read in either quote style and its references resolved; a name written inside another value is that
 * value's text. Text that is no attribute, such as the `/` of an empty tag, is skipped.
 */
export const readAttributes = (text: string): XmlAttribute[] => {
  const attributes: XmlAttribute[] = []
  let at = 0
  while (at < text.length) {
    if (isSpace(text[at]) || text[at] === '/') {
      at += 1
      continue
    }
    const nameStart = at
    while (at < text.length && !isSpace(text[at]) && text[at] !== '=' && text[at] !== '/') {
      at += 1
    }
    const name = text.slice(nameStart, at)
    while (at < text.length && isSpace(text[at])) {
      at += 1
    }
    if (text[at] !== '=') {
      continue
    }
    at += 1
    while (at < text.length && isSpace(text[at])) {
      at += 1
    }
    const quote = text[at]
    if (quote !== '"' && quote !== "'") {
      continue
    }
    const close = text.indexOf(quote, at + 1)
    const end = close === -1 ? text.length : close
    attributes.push({ ...splitName(name), value: decodeXml(text.slice(at + 1, end)) })
    at = end + 1
  }
  return attributes
}

/** The value of the last attribute with this local name, whatever its prefix: the one Go's encoding/xml keeps. */
export const lastValue = (attributes: XmlAttribute[], local: string) =>
  attributes.findLast((attribute) => attribute.local === local)?.value

/**
 * Visit each start tag of a part whose local name is one of `names`, any prefix, in order, with its attributes.
 * A character loop finds where each tag ends, a quoted `>` included, so it stays linear whatever the file holds.
 * `visit` returns false to stop.
 */
export const visitStartTags = (
  xml: string,
  names: ReadonlySet<string>,
  visit: (local: string, attributes: XmlAttribute[]) => boolean,
) => {
  let at = xml.indexOf('<')
  while (at !== -1) {
    let nameEnd = at + 1
    while (nameEnd < xml.length && !isSpace(xml[nameEnd]) && !'/><'.includes(xml[nameEnd])) {
      nameEnd += 1
    }
    let end = nameEnd
    while (end < xml.length && xml[end] !== '>' && xml[end] !== '<') {
      const quote = xml[end]
      const close = quote === '"' || quote === "'" ? xml.indexOf(quote, end + 1) : end
      end = close === -1 ? xml.length : close + 1
    }
    if (end >= xml.length) {
      return
    }
    // A `<` before the tag's end means no tag started here; the scan goes on from that `<`.
    if (xml[end] === '<') {
      at = end
      continue
    }
    const { local } = splitName(xml.slice(at + 1, nameEnd))
    if (names.has(local) && !visit(local, readAttributes(xml.slice(nameEnd, end)))) {
      return
    }
    at = xml.indexOf('<', end + 1)
  }
}

/** The attributes of each start tag of a part with this local name, any prefix. */
const tagsIn = (xml: string, name: string) => {
  const tags: XmlAttribute[][] = []
  visitStartTags(xml, new Set([name]), (_, attributes) => {
    tags.push(attributes)
    return true
  })
  return tags
}

/**
 * The targets of a part's relationships, by id and by type: each read by local name, the last one winning, as
 * Excelize reads them. A relationships part is a flat list, so it is read with a linear scan instead of a DOM: an
 * ordinary sheet with 12,000 links has 2.3 MiB of them.
 */
export const relationshipsOf = (parts: WorkbookParts, part: string) => {
  const slash = part.lastIndexOf('/') + 1
  const rels = parts[`${part.slice(0, slash)}_rels/${part.slice(slash)}.rels`]
  return tagsIn(rels ? scannableXml(strFromU8(rels)) : '', 'Relationship').map((attributes) => ({
    id: lastValue(attributes, 'Id'),
    type: lastValue(attributes, 'Type') ?? '',
    target: resolvePart(part, lastValue(attributes, 'Target') ?? ''),
  }))
}

/** The namespaces a sheet's relationship id is read in: transitional OOXML and strict. */
const relationshipNamespaces = new Set([ns.r, 'http://purl.oclc.org/ooxml/officeDocument/relationships'])

/** The namespace each prefix a tag declares stands for. */
const bindingsOf = (attributes: XmlAttribute[]) =>
  attributes.filter(({ prefix }) => prefix === 'xmlns').map(({ local, value }): [string, string] => [local, value])

/**
 * A sheet's relationship id, read by namespace as Excelize reads it: the `id` whose prefix the sheet's tag, the
 * `<sheets>` list or the workbook's root binds to the relationships namespace. An `id` whose prefix none of them
 * binds, or two that qualify, make the workbook refused: the preview could not tell which part Excelize reads.
 */
const relationshipIdOf = (attributes: XmlAttribute[], rootBindings: [string, string][]) => {
  const bindings = new Map([...rootBindings, ...bindingsOf(attributes)])
  const ids = attributes.filter(({ prefix, local }) => local === 'id' && prefix !== '' && prefix !== 'xmlns')
  if (ids.some(({ prefix }) => !bindings.has(prefix))) {
    throw new Error('A sheet of the workbook names its part through a prefix the workbook does not declare.')
  }
  const routed = ids.filter(({ prefix }) => relationshipNamespaces.has(bindings.get(prefix) ?? ''))
  if (routed.length > 1) {
    throw new Error('A sheet of the workbook names its part twice.')
  }
  return routed[0]?.value
}

/**
 * The names of the workbook's sheets in tab order, its worksheets with their parts, the parts its relationships name
 * and its shared strings part. `workbook.xml` is scanned for its `<sheet>` tags alone, so 32,000 defined names cost
 * no more than their bytes. A workbook that gives one relationship Id twice, or two sheets one name, is refused:
 * Excel never writes one, and Excelize could read a different part from the one the preview scans.
 */
export const workbookParts = (parts: WorkbookParts) => {
  const workbookPart = relationshipsOf(parts, '').find(({ type }) => type.endsWith('/officeDocument'))?.target ?? ''
  const rels = relationshipsOf(parts, workbookPart)
  const byId = new Map(rels.map((rel) => [rel.id, rel]))
  if (byId.size < rels.length) {
    throw new Error('The workbook gives one relationship Id to two parts.')
  }
  const workbookXml = scannableXml(strFromU8(parts[workbookPart] ?? new Uint8Array()))
  // A `<sheet>` sits inside `<sheets>` inside `<workbook>`, and either may declare the prefix its id uses. Excelize
  // also reads a second `<sheets>` list with its own declarations, which one set of bindings cannot follow.
  const [root = []] = tagsIn(workbookXml, 'workbook')
  const sheetLists = tagsIn(workbookXml, 'sheets')
  if (sheetLists.length > 1) {
    throw new Error('The workbook lists its sheets more than once.')
  }
  const rootBindings = [...bindingsOf(root), ...bindingsOf(sheetLists[0] ?? [])]
  const tabs = tagsIn(workbookXml, 'sheet').map((attributes) => ({
    name: lastValue(attributes, 'name') ?? '',
    rel: byId.get(relationshipIdOf(attributes, rootBindings)),
  }))
  const names = tabs.map(({ name }) => name)
  if (new Set(names.map((name) => name.toLowerCase())).size < names.length) {
    throw new Error('The workbook gives two sheets one name.')
  }
  return {
    names,
    sheets: tabs.flatMap(({ name, rel }) =>
      rel?.type.endsWith('/worksheet') && parts[rel.target] ? [{ name, part: rel.target }] : [],
    ),
    targets: rels.map(({ target }) => target),
    sharedStrings: rels.find(({ type }) => type.endsWith('/sharedStrings'))?.target,
  }
}

/** Read a chart part: one chart type is drawn or named, several make a combination chart. */
const parseChart = (xml: Uint8Array): ChartContent => {
  const doc = parseXml(xml)
  const chart = child(doc, 'chart')
  const title = titleOf(chart)
  const groups = childElements(child(chart, 'plotArea')).filter(
    (el) => el.namespaceURI === ns.c && el.localName?.endsWith('Chart'),
  )
  const [group] = groups
  if (groups.length !== 1) {
    return { type: 'placeholder', kind: groups.length > 1 ? 'combination' : chartExKind(doc), title }
  }
  const kind = kindOf(group)
  if (!isDrawn(kind)) {
    return { type: 'placeholder', kind, title }
  }
  const series = childElements(group)
    .filter((el) => el.localName === 'ser')
    .map((ser) => ({
      name: seriesData(child(ser, 'tx')),
      values: seriesData(child(ser, 'val')),
      categories: seriesData(child(ser, 'cat')),
    }))
  return { type: 'chart', kind, stacking: stackingOf(group), title, series }
}

/** A chart part, read once however many anchors show it. A part that does not parse costs that chart only. */
const chartReader = (parts: WorkbookParts) => {
  const read = new Map<string, ChartContent>()
  return (part: string | undefined, excel2016: boolean): ChartContent => {
    const xml = part && parts[part]
    if (!part || !xml) {
      return { type: 'placeholder', kind: 'other', title: '' }
    }
    const known = read.get(part)
    if (known) {
      return known
    }
    const content = ((): ChartContent => {
      try {
        return excel2016 ? { type: 'placeholder', kind: chartExKind(parseXml(xml)), title: '' } : parseChart(xml)
      } catch (error) {
        console.error('[xlsx-preview] Could not read a chart', error)
        return { type: 'placeholder', kind: 'other', title: '' }
      }
    })()
    read.set(part, content)
    return content
  }
}

/** What one anchor holds. An Excel 2016 chart (`cx:chart`) becomes a placeholder that names its type. */
const contentOf = (
  el: Element,
  parts: WorkbookParts,
  targetOf: (id: string | null) => string | undefined,
  readChart: ReturnType<typeof chartReader>,
): DrawingContent | undefined => {
  const frame = first(el, ns.xdr, 'graphicFrame')
  if (frame) {
    const chart = first(frame, ns.c, 'chart')
    const chartEx = first(frame, ns.cx, 'chart')
    return readChart(targetOf((chart ?? chartEx)?.getAttributeNS(ns.r, 'id') ?? null), !chart && !!chartEx)
  }
  if (first(el, ns.xdr, 'grpSp')) {
    return { type: 'shape' }
  }
  const picture = first(el, ns.xdr, 'pic')
  if (picture) {
    // Only bytes inside the file: a linked picture (`r:link`) is never fetched, and comes back with none, to be counted.
    const bytes = parts[targetOf(first(picture, ns.a, 'blip')?.getAttributeNS(ns.r, 'embed') ?? null) ?? '']
    const alt = first(picture, ns.xdr, 'cNvPr')?.getAttribute('descr') ?? ''
    return { type: 'image', bytes: bytes ?? new Uint8Array(), alt }
  }
  return first(el, ns.xdr, 'sp') || first(el, ns.xdr, 'cxnSp') ? { type: 'shape' } : undefined
}

const anchorNames = new Set(['twoCellAnchor', 'oneCellAnchor', 'absoluteAnchor'])

/**
 * The charts, pictures and shapes a worksheet's drawings hold, or `undefined` when a drawing part is too large to
 * parse. Excelize has no call that reads a chart, so the drawing and chart parts are read here.
 */
export const drawingObjects = (parts: WorkbookParts, sheetPart: string): DrawingObject[] | undefined => {
  const readChart = chartReader(parts)
  const drawings = relationshipsOf(parts, sheetPart).filter(
    ({ type, target }) => type.endsWith('/drawing') && parts[target],
  )
  if (drawings.some(({ target }) => parts[target].length > xlsxPreviewLimits.xmlPartBytes)) {
    return undefined
  }
  return drawings.flatMap(({ target }) => {
    const rels = relationshipsOf(parts, target)
    const targetOf = (id: string | null) => rels.find((rel) => rel.id === id && id !== null)?.target
    return childElements(parseXml(parts[target]))
      .filter((el) => anchorNames.has(el.localName ?? ''))
      .flatMap((el) => {
        const content = contentOf(el, parts, targetOf, readChart)
        return content ? [{ ...content, anchor: anchorOf(el) }] : []
      })
  })
}
