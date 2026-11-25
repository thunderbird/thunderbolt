/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*!
 * MIT License
 *
 * Copyright (c) 2026 Yuichiro Yamashita
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// Behavior bodies ported from the native captures in office-kit/pptx at 7989516763efa55104654968f6d114879e0b9dba.
export const presets = {
  appear: { id: 1, cls: 'entr', duration: 1 },
  fadeIn: { id: 10, cls: 'entr', duration: 500 },
  flyIn: { id: 2, cls: 'entr', duration: 500 },
  wipeIn: { id: 22, cls: 'entr', duration: 500 },
  blink: { id: 35, cls: 'emph', duration: 1000 },
  pulse: { id: 26, cls: 'emph', duration: 500 },
  growShrink: { id: 6, cls: 'emph', duration: 2000 },
  spin: { id: 8, cls: 'emph', duration: 2000 },
  disappear: { id: 1, cls: 'exit', duration: 1 },
  fadeOut: { id: 10, cls: 'exit', duration: 500 },
}

export const edges = {
  top: { subtype: 1, x: '#ppt_x', y: '0-#ppt_h/2', wipe: 'up', travel: 'd' },
  right: { subtype: 2, x: '1+#ppt_w/2', y: '#ppt_y', wipe: 'right', travel: 'l' },
  bottom: { subtype: 4, x: '#ppt_x', y: '1+#ppt_h/2', wipe: 'down', travel: 'u' },
  left: { subtype: 8, x: '0-#ppt_w/2', y: '#ppt_y', wipe: 'left', travel: 'r' },
}

export type Effect = keyof typeof presets
export type Edge = keyof typeof edges

/** Render one captured effect's ordered behaviors, allocating time IDs on the containing slide. */
export const presetBody = (effect: Effect, direction: Edge, duration: number, spid: number, nextId: () => number) => {
  const target = `<p:tgtEl><p:spTgt spid="${spid}"/></p:tgtEl>`
  const attr = (name: string) => `<p:attrNameLst><p:attrName>${name}</p:attrName></p:attrNameLst>`
  const clock = (attrs: string) => `<p:cTn id="${nextId()}" dur="${duration}"${attrs}/>`
  const visibility = (visible: boolean, delay = 0) =>
    `<p:set><p:cBhvr><p:cTn id="${nextId()}" dur="1" fill="hold"><p:stCondLst><p:cond delay="${delay}"/></p:stCondLst></p:cTn>${target}${attr('style.visibility')}</p:cBhvr><p:to><p:strVal val="${visible ? 'visible' : 'hidden'}"/></p:to></p:set>`
  const filter = (transition: string, name: string, attrs = '') =>
    `<p:animEffect transition="${transition}" filter="${name}"><p:cBhvr>${clock(attrs)}${target}</p:cBhvr></p:animEffect>`
  const scale = (timing: string, by: number) =>
    `<p:animScale><p:cBhvr>${timing}${target}</p:cBhvr><p:by x="${by}" y="${by}"/></p:animScale>`
  const key = (time: number, value: string) => `<p:tav tm="${time}"><p:val><p:strVal val="${value}"/></p:val></p:tav>`
  const fly = (axis: 'x' | 'y') =>
    `<p:anim calcmode="lin" valueType="num"><p:cBhvr additive="base">${clock(' fill="hold"')}${target}${attr('ppt_' + axis)}</p:cBhvr><p:tavLst>${key(0, edges[direction][axis])}${key(100000, '#ppt_' + axis)}</p:tavLst></p:anim>`
  switch (effect) {
    case 'appear':
      return visibility(true)
    case 'disappear':
      return visibility(false)
    case 'fadeIn':
      return visibility(true) + filter('in', 'fade')
    case 'fadeOut':
      return filter('out', 'fade') + visibility(false, duration - 1)
    case 'wipeIn':
      return visibility(true) + filter('in', `wipe(${edges[direction].wipe})`)
    case 'flyIn':
      return visibility(true) + fly('x') + fly('y')
    case 'growShrink':
      return scale(clock(' fill="hold"'), 150000)
    case 'pulse':
      return (
        filter('out', 'fade', ' tmFilter="0, 0; .2, .5; .8, .5; 1, 0"') +
        (duration > 1
          ? scale(`<p:cTn id="${nextId()}" dur="${Math.floor(duration / 2)}" autoRev="1" fill="hold"/>`, 105000)
          : '')
      )
    case 'spin':
      return `<p:animRot by="21600000"><p:cBhvr>${clock(' fill="hold"')}${target}${attr('r')}</p:cBhvr></p:animRot>`
    case 'blink':
      return `<p:anim calcmode="discrete" valueType="str"><p:cBhvr>${clock(' fill="hold"')}${target}${attr('style.visibility')}</p:cBhvr><p:tavLst>${key(0, 'hidden')}${key(50000, 'visible')}</p:tavLst></p:anim>`
  }
}
