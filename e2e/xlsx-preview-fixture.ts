/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import JSZip from 'jszip'

/** Where the hostile workbook's linked picture points. The page must never request it. */
export const hostileProbeOrigin = 'https://xlsx-probe.invalid'

export const hostileFilename = 'e2e-hostile.xlsx'

/** Text in a cell. It would set `window.__xlsxProbe` if it ever ran as markup. */
export const hostileScriptText = '<script>window.__xlsxProbe=1</script>'

const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const relationships = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const relationshipType = (type: string) => `${relationships}/${type}`

const escapeXml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

const rels = (entries: string[]) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries.join('')}</Relationships>`

const inlineCell = (ref: string, text: string) => `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(text)}</t></is></c>`

/**
 * A hostile workbook, written part by part: markup in cell text and in the sheet name, a `javascript:` link, and a
 * picture linked to a URL outside the file.
 */
export const hostileWorkbook = async (): Promise<Buffer> => {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`,
  )
  zip.file(
    '_rels/.rels',
    rels([`<Relationship Id="rId1" Type="${relationshipType('officeDocument')}" Target="xl/workbook.xml"/>`]),
  )
  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${main}" xmlns:r="${relationships}"><sheets><sheet name="${escapeXml('<img src=x onerror=alert(1)>')}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  )
  zip.file(
    'xl/_rels/workbook.xml.rels',
    rels([`<Relationship Id="rId1" Type="${relationshipType('worksheet')}" Target="worksheets/sheet1.xml"/>`]),
  )
  zip.file(
    'xl/worksheets/sheet1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${main}" xmlns:r="${relationships}"><sheetData>` +
      `<row r="1">${inlineCell('A1', '<img src=x onerror="window.__xlsxProbe=1">')}${inlineCell('B1', hostileScriptText)}</row>` +
      `<row r="2">${inlineCell('A2', 'click me')}</row>` +
      `</sheetData><hyperlinks><hyperlink ref="A2" r:id="rId1"/></hyperlinks><drawing r:id="rId2"/></worksheet>`,
  )
  zip.file(
    'xl/worksheets/_rels/sheet1.xml.rels',
    rels([
      `<Relationship Id="rId1" Type="${relationshipType('hyperlink')}" Target="javascript:window.__xlsxProbe=1" TargetMode="External"/>`,
      `<Relationship Id="rId2" Type="${relationshipType('drawing')}" Target="../drawings/drawing1.xml"/>`,
    ]),
  )
  zip.file(
    'xl/drawings/drawing1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${relationships}">` +
      `<xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>4</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
      `<xdr:to><xdr:col>2</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>8</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
      `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="linked"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:link="rId1"/></xdr:blipFill><xdr:spPr/></xdr:pic><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`,
  )
  zip.file(
    'xl/drawings/_rels/drawing1.xml.rels',
    rels([
      `<Relationship Id="rId1" Type="${relationshipType('image')}" Target="${hostileProbeOrigin}/linked.png" TargetMode="External"/>`,
    ]),
  )
  return zip.generateAsync({ type: 'nodebuffer' })
}
