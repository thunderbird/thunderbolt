/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { externalDataFormulas, isDdeFormula, withFuturePrefixes } from './formula-cache'

describe('withFuturePrefixes', () => {
  it('reads escaped quotes in an array constant, and an unclosed constant in linear time', () => {
    expect(withFuturePrefixes('CONCAT({"a""b",""},FILTER(A1:A3,B1:B3))')).toBe(
      '_xlfn.CONCAT({"a""b",""},_xlfn._xlws.FILTER(A1:A3,B1:B3))',
    )
    const started = performance.now()
    withFuturePrefixes(`SUM({"${'""'.repeat(32)}`)
    expect(performance.now() - started).toBeLessThan(250)
  })

  it('prefixes functions added after 2007 and leaves older ones and quoted text alone', () => {
    expect(withFuturePrefixes('concat("a","AGGREGATE(1)")&SUM(IFS(TRUE,1))')).toBe(
      '_xlfn.CONCAT("a","AGGREGATE(1)")&SUM(_xlfn.IFS(TRUE,1))',
    )
    expect(withFuturePrefixes('ROWS(FILTER(B1:B2,B1:B2=0))')).toBe('ROWS(_xlfn._xlws.FILTER(B1:B2,B1:B2=0))')
    expect(withFuturePrefixes('_xlfn.CONCAT("c")')).toBe('_xlfn.CONCAT("c")')
  })

  it('leaves table columns, quoted sheet names and array constants as they are', () => {
    expect(withFuturePrefixes('SUM(Table1[CONCAT(foo)])')).toBe('SUM(Table1[CONCAT(foo)])')
    expect(withFuturePrefixes("SUM(Table1[[#This Row],[IFS(a']b)]])")).toBe("SUM(Table1[[#This Row],[IFS(a']b)]])")
    expect(withFuturePrefixes("SUM('CONCAT(x)'!A1)")).toBe("SUM('CONCAT(x)'!A1)")
    expect(withFuturePrefixes('SUM({1,"IFS(}"})')).toBe('SUM({1,"IFS(}"})')
  })

  it('prefixes the parameters of a LAMBDA and the uses of them', () => {
    expect(withFuturePrefixes('LAMBDA(temp,temp+1)(2)')).toBe('_xlfn.LAMBDA(_xlpm.temp,_xlpm.temp+1)(2)')
    expect(withFuturePrefixes('LAMBDA(x, y, x*y)(2, 3)+x')).toBe(
      '_xlfn.LAMBDA(_xlpm.x, _xlpm.y, _xlpm.x*_xlpm.y)(2, 3)+x',
    )
  })

  it('prefixes the names a LET declares, but not the values it binds them to', () => {
    expect(withFuturePrefixes('LET(a,{1,2},b,SUM(a),a+b+c)')).toBe(
      '_xlfn.LET(_xlpm.a,{1,2},_xlpm.b,SUM(_xlpm.a),_xlpm.a+_xlpm.b+c)',
    )
    expect(withFuturePrefixes('LET(f,LAMBDA(n,n*2),f(A1))')).toBe(
      '_xlfn.LET(_xlpm.f,_xlfn.LAMBDA(_xlpm.n,_xlpm.n*2),_xlpm.f(A1))',
    )
    expect(withFuturePrefixes('LET(x,1,LET(y,x,x+y))+y')).toBe(
      '_xlfn.LET(_xlpm.x,1,_xlfn.LET(_xlpm.y,_xlpm.x,_xlpm.x+_xlpm.y))+y',
    )
  })

  it('leaves sheet names, and names on a named sheet, alone when they match a declared name', () => {
    expect(withFuturePrefixes('LET(x,1,x!A1+x)')).toBe('_xlfn.LET(_xlpm.x,1,x!A1+_xlpm.x)')
    expect(withFuturePrefixes('LET(x,1,y,2,SUM(x:y!A1)+x:y)')).toBe(
      '_xlfn.LET(_xlpm.x,1,_xlpm.y,2,SUM(x:y!A1)+_xlpm.x:_xlpm.y)',
    )
    expect(withFuturePrefixes("LET(rate,1,Sheet2!rate+'My Sheet'!rate+rate)")).toBe(
      "_xlfn.LET(_xlpm.rate,1,Sheet2!rate+'My Sheet'!rate+_xlpm.rate)",
    )
    expect(withFuturePrefixes('LET(x,1,[Book.xlsx]x!A1+x)')).toBe('_xlfn.LET(_xlpm.x,1,[Book.xlsx]x!A1+_xlpm.x)')
  })
})

describe('externalDataFormulas', () => {
  const formulasIn = (xml: string) => externalDataFormulas(xml).map(({ formula }) => formula)

  it('finds a formula that fetches outside data however the XML writes it', () => {
    for (const xml of [
      '<c r="A1"><f>_xlfn.WEBSERVICE("https://x/?q="&amp;B1)</f></c>',
      '<c r="A1"><x:f>webservice("https://x")</x:f></c>',
      '<c r="A1"><f>WEB<!-- -->SERVICE("https://x")</f></c>',
      '<c r="A1"><f><![CDATA[_xlfn.IMAGE("https://x/a.png")]]></f></c>',
      `<c r="A1"><f>"it's"&amp;WEBSERVICE("https://x")&amp;"'"</f></c>`,
      '<c r="A1"><f>[a]WEBSERVICE("https://x")[b]</f></c>',
      '<c r="A1"><f><!-- </f> -->WEBSERVICE("https://x")</f></c>',
      '<c r="A1"><f><![CDATA[IF(A1<2,WEBSERVICE("https://x"),0)]]></f></c>',
      '<c r="A1"><f>WEB<x:y/>SERVICE("https://x")</f></c>',
      '<c r="A1"><f a=">">WEBSERVICE("https://x")</f></c>',
      '<?xml version="1.0"?><c r="A1"><f>WEBSERVICE("https://x")</f></c>',
      '<c r="A1"><f>&#87;EBSERVICE("https://x")</f></c>',
      '<c r="A1"><f>_xlfn.MAP(B1:B3,_xlfn._xleta.WEBSERVICE)</f></c>',
      '<definedName name="u">_xlfn.WEBSERVICE(Sheet1!$B$1)</definedName>',
      '<cfRule type="expression" priority="1"><formula>LEN(_xlfn.WEBSERVICE("https://x"))&gt;0</formula></cfRule>',
      '<x14:dataValidation><x14:formula1><xm:f>RTD("a.b","host","t")</xm:f></x14:formula1></x14:dataValidation>',
      '<tableColumn id="2" name="B"><calculatedColumnFormula>IMPORTDATA("https://x")</calculatedColumnFormula></tableColumn>',
      '<c r="A1"><f>WEBSERVICE("https://x")</f ></c>',
      '<c r="A1"><f>WEB<x:y a=">"/>SERVICE("https://x")</f></c>',
      '<c r="A1"><f>WEB<x:y>skipped</x:y>SERVICE("https://x")</f></c>',
      `<c r="A1"><f>Table1['[]&amp;WEBSERVICE("https://x")&amp;"]"</f></c>`,
      '<cfvo type="formula" val="WEBSERVICE(&quot;https://x&quot;)"/>',
      '<cacheField name="c" numFmtId="0" formula="IMAGE(&quot;https://x/a.png&quot;)"/>',
      '<calculatedItem formula="RTD(&quot;a.b&quot;,,&quot;t&quot;)"><pivotArea/></calculatedItem>',
      // A prefix is any XML name, so it may hold letters outside ASCII.
      '<c r="A1"><ñ:f>WEBSERVICE("https://x")</ñ:f></c>',
      '<c r="A1"><表-1:f>WEBSERVICE("https://x")</表-1:f></c>',
      '<ñ:cfvo type="formula" val="WEBSERVICE(&quot;https://x&quot;)"/>',
    ]) {
      expect(externalDataFormulas(xml)).toHaveLength(1)
    }
    expect(formulasIn('<c r="A1"><f> WEB<!-- -->SERVICE("https://x?a=1&amp;b=2") </f></c>')).toEqual([
      'WEBSERVICE("https://x?a=1&b=2")',
    ])
    expect(formulasIn('<c r="A1"><f>WEB<x:y/>SERVICE("https://x")</f></c>')).toEqual(['WEB<x:y/>SERVICE("https://x")'])
  })

  it('keys and shows escaped text and real markup apart, though both decode the same', () => {
    const [escaped] = externalDataFormulas('<c r="A1"><f>WEBSERVICE("https://x/&lt;x:y/&gt;"&amp;B1)</f></c>')
    const [markup] = externalDataFormulas('<c r="A1"><f>WEBSERVICE("https://x/<x:y/>"&amp;B1)</f></c>')

    expect(escaped).toEqual({
      formula: 'WEBSERVICE("https://x/<x:y/>"&B1)',
      key: 'text:WEBSERVICE("https://x/<x:y/>"&B1)',
      dde: false,
    })
    expect(markup).toEqual({
      formula: 'WEBSERVICE("https://x/<x:y/>"&amp;B1)',
      key: 'markup:WEBSERVICE("https://x/<x:y/>"&amp;B1)',
      dde: false,
    })
  })

  it('tells a DDE request in a formula with markup from its decoded text, not as written', () => {
    const [pipe] = externalDataFormulas(`<c r="A1"><f>cmd&#124;' /C calc'!A0<x:y/></f></c>`)
    const [quoted] = externalDataFormulas('<c r="A1"><f>WEBSERVICE(&quot;a|b&quot;)<x:y/></f></c>')

    expect(pipe.dde).toBe(true)
    expect(quoted.dde).toBe(false)
    // A tag's own attribute is no part of the formula, and a tag may split a function's name.
    expect(externalDataFormulas('<c r="A1"><f>WEBSERVICE(&quot;a<x:y a="|"/>b&quot;)</f></c>')[0].dde).toBe(false)
    expect(externalDataFormulas('<c r="A1"><f>D<x:y/>DE(A1,B1,C1)</f></c>')[0].dde).toBe(true)
  })

  it('leaves text, cached values and look-alike names alone', () => {
    for (const xml of [
      '<c r="A1" t="inlineStr"><is><t>Use IMAGE(url) for pictures</t></is></c>',
      '<c r="A1" t="str"><f>"Image ("&amp;B1&amp;")"</f><v>Image (1)</v></c>',
      `<c r="A1"><f>'IMAGE (2)'!A1+1</f></c>`,
      '<c r="A1"><f>Table1[[#This Row],[Image (URL)]]&amp;[1]Sheet1!A1</f></c>',
      '<c r="A1"><f>HYPERLINK("https://x","open")</f></c>',
      '<c r="A1"><f>SUM(IMAGES)+MYIMAGE(1)+T.IMAGE</f></c>',
      '<c r="A1"><f>FILTERXML(B1,"//a")&amp;_xlfn.ENCODEURL(B2)</f></c>',
      `<c r="A1"><f>Table1['[Image (URL)']]</f></c>`,
      '<x14:dataValidation><x14:formula1><xm:f>"Image (URL),Text"</xm:f></x14:formula1></x14:dataValidation>',
      '<cfvo type="num" val="0"/><cacheField name="IMAGE(1)" numFmtId="0"/>',
      '<x14:dataValidation><x14:formula1><ñ:f>A1:A3</ñ:f></x14:formula1></x14:dataValidation>',
      '<c r="A1"><fée>WEBSERVICE("https://x")</fée></c>',
    ]) {
      expect(externalDataFormulas(xml)).toEqual([])
    }
  })

  it('finds a DDE request written as app|topic!item, but not a | in quotes or a quoted sheet name', () => {
    expect(formulasIn(`<c r="A1"><f>cmd|' /C calc'!A0</f></c>`)).toEqual([`cmd|' /C calc'!A0`])
    expect(externalDataFormulas(`<c r="A1"><f>1+c<!-- -->md|'/C calc'!A0</f></c>`)).toHaveLength(1)
    expect(isDdeFormula(`cmd|' /C calc'!A0`)).toBe(true)
    expect(externalDataFormulas(`<c r="A1"><f>"a|b"&amp;'x|y'!A1&amp;Table1[a|b]</f></c>`)).toEqual([])
  })

  it("finds LibreOffice's DDE function", () => {
    expect(externalDataFormulas('<c r="A1"><f>DDE("soffice";"C:\\a.ods";"A1")</f></c>')).toHaveLength(1)
    expect(isDdeFormula('_xlfn.DDE("soffice","a","b")')).toBe(true)
    expect(isDdeFormula('WEBSERVICE("https://x")')).toBe(false)
  })

  it('reads a formula attribute after another attribute whose value spells one', () => {
    expect(formulasIn(`<cacheField name=" formula='0'" formula="WEBSERVICE(&quot;https://x&quot;)"/>`)).toEqual([
      'WEBSERVICE("https://x")',
    ])
  })
})
