/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { withFuturePrefixes } from './formula-cache'

describe('withFuturePrefixes', () => {
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
  })
})
