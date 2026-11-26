/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import type PptxGenJS from 'pptxgenjs'

const contentTypes = '[Content_Types].xml'

const override = /<Override PartName="\/([^"]+)"[^>]*\/>/g

const chartPart = /^ppt\/charts\/chart\d+\.xml$/

/** Category labels with one level, as PptxGenJS writes them: a multi-level reference that holds one level. */
const oneLevelCategories =
  /<c:multiLvlStrRef>\s*(<c:f>[^<]*<\/c:f>)\s*<c:multiLvlStrCache>\s*(<c:ptCount val="\d+"\/>)\s*<c:lvl>((?:<c:pt idx="\d+"><c:v>[^<]*<\/c:v><\/c:pt>)*)<\/c:lvl>\s*<\/c:multiLvlStrCache>\s*<\/c:multiLvlStrRef>/g

/** PptxGenJS numbers tables by table count × slide number + 1, independently of the other drawing IDs. */
const fixTableIds = (xml: string) => {
  if (!xml.includes('<a:tbl>')) {
    return xml
  }
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  let highest = 0
  for (const [, id] of xml.matchAll(/<p:cNvPr id="(\d+)"/g)) {
    if (seen.has(id)) {
      duplicates.add(id)
    }
    seen.add(id)
    highest = Math.max(highest, Number(id))
  }
  // This is the table header emitted by PptxGenJS. Leave IDs referenced by media and other drawings alone.
  return xml.replace(/(<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id=")(\d+)"/g, (match, prefix, id) =>
    duplicates.has(id) ? `${prefix}${++highest}"` : match,
  )
}

/**
 * Repair generated table IDs and two package faults. PptxGenJS declares a content type for one slide master per slide, but
 * writes only the first. And it writes a chart's one-level category labels as a multi-level reference, which Google
 * Slides and the app's preview do not read, so the chart loses its labels there; the equivalent plain string
 * reference shows them everywhere. `level` is the zip compression: 0 stores the parts, as PptxGenJS does by default.
 */
export const fixPresentation = (bytes: Uint8Array, level: 0 | 6) => {
  const parts = unzipSync(bytes)
  parts[contentTypes] = strToU8(
    strFromU8(parts[contentTypes]).replace(override, (entry, name: string) => (name in parts ? entry : '')),
  )
  for (const name of Object.keys(parts).filter((part) => chartPart.test(part))) {
    parts[name] = strToU8(
      strFromU8(parts[name]).replace(oneLevelCategories, '<c:strRef>$1<c:strCache>$2$3</c:strCache></c:strRef>'),
    )
  }
  for (const name of Object.keys(parts).filter((part) => /^ppt\/slides\/slide\d+\.xml$/.test(part))) {
    const xml = strFromU8(parts[name])
    const fixed = fixTableIds(xml)
    if (fixed !== xml) {
      parts[name] = strToU8(fixed)
    }
  }
  return zipSync(parts, { level })
}

/**
 * Make PptxGenJS's `write` return fixed bytes (see `fixPresentation`) for the output types a script can save, a
 * Uint8Array or an ArrayBuffer. Other output types come back as PptxGenJS wrote them.
 */
export const fixPptxGenJsOutput = (pptxgenjs: typeof PptxGenJS) => {
  const { write } = pptxgenjs.prototype
  // A method, not an arrow function: `write` reads the presentation from `this`.
  pptxgenjs.prototype.write = async function (props) {
    const output = await write.call(this, props)
    const level = props?.compression === true ? 6 : 0
    if (output instanceof Uint8Array) {
      return fixPresentation(output, level)
    }
    return output instanceof ArrayBuffer
      ? new Uint8Array(fixPresentation(new Uint8Array(output), level)).buffer
      : output
  }
}
