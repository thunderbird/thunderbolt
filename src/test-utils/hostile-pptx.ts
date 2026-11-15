/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { samplePptx } from './sample-pptx'

/** The origin the hostile deck's pictures and link point at. No request may reach it. */
export const hostilePptxProbeOrigin = 'https://pptx-probe.invalid'

/** Text on the hostile slide that is markup a renderer must show as text. */
export const hostileMarkupText = '<img src=x onerror="window.__pptxProbe=1"></style>'

/** The text of the hostile slide's links. */
export const hostileLinkText = { script: 'Run the script', web: 'Open the site' }

const external = (id: string, type: string, target: string) =>
  `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" ` +
  `Target="${target}" TargetMode="External"/>`

const position = (y: number) =>
  `<a:xfrm><a:off x="457200" y="${y}"/><a:ext cx="4572000" cy="457200"/></a:xfrm>` +
  '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'

const textBox = (id: number, y: number, run: string) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${position(y)}` +
  `</p:spPr><p:txBody><a:bodyPr/><a:p>${run}</a:p></p:txBody></p:sp>`

const linkRun = (id: string, text: string) =>
  `<a:r><a:rPr lang="en-US"><a:hlinkClick r:id="${id}"/></a:rPr><a:t>${text}</a:t></a:r>`

const escapeXml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')

/** What the first slide gains: a picture and a picture fill from outside the file, two links, and markup. */
const hostileContent =
  '<p:pic><p:nvPicPr><p:cNvPr id="20" name="Picture"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill>' +
  `<a:blip r:embed="rIdProbePicture"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${position(3657600)}` +
  '</p:spPr></p:pic>' +
  `<p:sp><p:nvSpPr><p:cNvPr id="21" name="Fill"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${position(4114800)}` +
  '<a:blipFill><a:blip r:link="rIdProbeFill"/><a:stretch><a:fillRect/></a:stretch></a:blipFill></p:spPr></p:sp>' +
  textBox(22, 2286000, linkRun('rIdScript', hostileLinkText.script)) +
  textBox(23, 2743200, linkRun('rIdWeb', hostileLinkText.web)) +
  textBox(24, 3200400, `<a:r><a:rPr lang="en-US"/><a:t>${escapeXml(hostileMarkupText)}</a:t></a:r>`)

/**
 * A background gradient whose first color closes the CSS gradient the renderer writes and adds a picture from
 * {@link hostilePptxProbeOrigin}. The renderer puts the color in the slide's CSS as the file gives it.
 */
const hostileBackground =
  '<p:bg><p:bgPr><a:gradFill><a:gsLst><a:gs pos="0">' +
  `<a:srgbClr val="ffffff 0%, #ffffff 100%), url(${hostilePptxProbeOrigin}/background.png), linear-gradient(#ffffff"/>` +
  '</a:gs><a:gs pos="100000"><a:srgbClr val="ffffff"/></a:gs></a:gsLst><a:lin ang="0"/></a:gradFill></p:bgPr></p:bg>'

/**
 * The sample deck with a first slide that tries to load pictures from {@link hostilePptxProbeOrigin}, as pictures,
 * as a fill and through its background's CSS, links to a `javascript:` URL and to a web page, and holds text that is
 * markup.
 */
export const hostilePptx = async (): Promise<Uint8Array> => {
  const parts = unzipSync(await samplePptx())
  const slide = 'ppt/slides/slide1.xml'
  const rels = 'ppt/slides/_rels/slide1.xml.rels'
  parts[slide] = strToU8(
    strFromU8(parts[slide])
      .replace('<p:spTree>', `${hostileBackground}<p:spTree>`)
      .replace('</p:spTree>', `${hostileContent}</p:spTree>`),
  )
  parts[rels] = strToU8(
    strFromU8(parts[rels]).replace(
      '</Relationships>',
      external('rIdProbePicture', 'image', `${hostilePptxProbeOrigin}/picture.png`) +
        external('rIdProbeFill', 'image', `${hostilePptxProbeOrigin}/fill.png`) +
        external('rIdScript', 'hyperlink', 'javascript:window.__pptxProbe=1') +
        external('rIdWeb', 'hyperlink', `${hostilePptxProbeOrigin}/page`) +
        '</Relationships>',
    ),
  )
  return zipSync(parts)
}
