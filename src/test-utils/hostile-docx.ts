/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { strToU8, zipSync } from 'fflate'

/** Where the hostile document's linked picture and refresh point. The page must never request it. */
export const hostileDocxProbeOrigin = 'https://docx-probe.invalid'

/** Text in the document's embedded HTML part, which a preview must not show. */
export const hostileAltChunkText = 'Embedded HTML part'

/** The document's one link, whose target runs script. */
export const hostileLinkText = 'click me'

const relationships = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const relationshipType = (type: string) => `${relationships}/${type}`

const rels = (entries: string[]) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries.join('')}</Relationships>`

const wordNamespaces =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  `xmlns:r="${relationships}" ` +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"'

/** A font name that tries to close the style element it lands in and add a refresh to the probe. */
const breakoutFont = `x&lt;/style&gt;&lt;meta http-equiv=&quot;refresh&quot; content=&quot;0;url=${hostileDocxProbeOrigin}/refresh&quot;&gt;`

/**
 * A hostile document, written part by part: an embedded HTML part (altChunk) with a script, a `javascript:` link, a
 * picture linked to a URL outside the file, and a style whose font name tries to break out of the preview's CSS.
 */
export const hostileDocx = (): Uint8Array<ArrayBuffer> =>
  zipSync({
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/><Default Extension="html" ContentType="text/html"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
        '</Types>',
    ),
    '_rels/.rels': strToU8(
      rels([`<Relationship Id="rId1" Type="${relationshipType('officeDocument')}" Target="word/document.xml"/>`]),
    ),
    'word/document.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${wordNamespaces}><w:body>` +
        '<w:p><w:pPr><w:pStyle w:val="Breakout"/></w:pPr><w:r><w:t>Hostile document</w:t></w:r></w:p>' +
        '<w:altChunk r:id="rIdChunk"/>' +
        `<w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>${hostileLinkText}</w:t></w:r></w:hyperlink></w:p>` +
        '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="linked"/>' +
        '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>' +
        '<pic:nvPicPr><pic:cNvPr id="1" name="linked"/><pic:cNvPicPr/></pic:nvPicPr>' +
        '<pic:blipFill><a:blip r:embed="rIdImage"/></pic:blipFill>' +
        '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm></pic:spPr>' +
        '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>' +
        '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>',
    ),
    'word/styles.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${wordNamespaces}>` +
        `<w:style w:type="paragraph" w:styleId="Breakout"><w:name w:val="Breakout"/><w:rPr><w:rFonts w:ascii="${breakoutFont}"/></w:rPr></w:style>` +
        '</w:styles>',
    ),
    'word/chunk.html': strToU8(
      `<html><body><script>window.__docxProbe = 1</script><p>${hostileAltChunkText}</p></body></html>`,
    ),
    'word/_rels/document.xml.rels': strToU8(
      rels([
        `<Relationship Id="rIdStyles" Type="${relationshipType('styles')}" Target="styles.xml"/>`,
        `<Relationship Id="rIdChunk" Type="${relationshipType('aFChunk')}" Target="chunk.html"/>`,
        `<Relationship Id="rIdLink" Type="${relationshipType('hyperlink')}" Target="javascript:window.__docxProbe=1" TargetMode="External"/>`,
        `<Relationship Id="rIdImage" Type="${relationshipType('image')}" Target="${hostileDocxProbeOrigin}/linked.png" TargetMode="External"/>`,
      ]),
    ),
  })
