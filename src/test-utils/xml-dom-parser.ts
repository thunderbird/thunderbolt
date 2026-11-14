/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DOMParser as XmlDomParser } from '@xmldom/xmldom'
import { afterAll, beforeAll } from 'bun:test'

/**
 * Parses XML with xmldom for the tests of the file that calls it. happy-dom gives a prefixed attribute such as `w:val`
 * the local name `w:val` and no namespace, so docx-preview, which reads attributes by local name as browsers report
 * them, finds none of a document's styles, sizes or pictures. HTML still parses with happy-dom.
 */
export const parseXmlWithXmlDom = () => {
  const HappyDomParser = globalThis.DOMParser
  class TestDomParser {
    parseFromString(text: string, type: DOMParserSupportedType) {
      if (type !== 'application/xml') {
        return new HappyDomParser().parseFromString(text, type)
      }
      const xml = new XmlDomParser().parseFromString(text, type)
      // xmldom's documents have no `firstElementChild`, which docx-preview reads.
      Object.defineProperty(xml, 'firstElementChild', { get: () => xml.documentElement })
      return xml
    }
  }
  beforeAll(() => {
    Object.defineProperty(globalThis, 'DOMParser', { configurable: true, writable: true, value: TestDomParser })
  })
  afterAll(() => {
    Object.defineProperty(globalThis, 'DOMParser', { configurable: true, writable: true, value: HappyDomParser })
  })
}
