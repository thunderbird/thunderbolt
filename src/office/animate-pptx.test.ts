/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { expect, test } from 'bun:test'
import { DOMParser, type Element } from '@xmldom/xmldom'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { runSandboxedScript, type SandboxInput } from './sandbox'
import { loadTestSandboxRuntime } from './sandbox-test-runtime'

const runtime = loadTestSandboxRuntime()
const p = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const fixture = (name: string) => Bun.file(`${import.meta.dir}/test-fixtures/${name}`)
const parse = (s: string) => new DOMParser().parseFromString(s, 'application/xml').documentElement!
const all = (el: Element, name: string) => Array.from(el.getElementsByTagNameNS(p, name))
const attr = (el: Element, key: string) => el.getAttribute(key)
const part = (n: number) => `ppt/slides/slide${n}.xml`
const run = async (script: string, inputs: SandboxInput[] = []) => {
  const result = await runSandboxedScript(await runtime, { script, inputs })
  if (!result.ok) {
    throw new Error(result.error)
  }
  return result
}
const presetNames = [
  'appear',
  'fadeIn',
  'flyIn',
  'wipeIn',
  'blink',
  'pulse',
  'growShrink',
  'spin',
  'disappear',
  'fadeOut',
]
const deckScript = `
const pres = new PptxGenJS()
const addSlide = () => {
  const slide = pres.addSlide()
  slide.addText('Filled badge', {objectName:'Badge', x:1,y:1,w:2,h:1,fill:{color:'004466'}})
  return slide
}
const write = () => pres.write({outputType:'uint8array'})
`

/** Compare expanded names and ordered behavior trees, remapping drawing and clock IDs independently. */
const canonical = (root: Element) => {
  const clocks = new Map(all(root, 'cTn').map((node, i) => [attr(node, 'id'), String(i)]))
  const drawings = new Map(all(root, 'spTgt').map((node, i) => [attr(node, 'spid'), String(i)]))
  const visit = (el: Element): string =>
    JSON.stringify([
      el.namespaceURI,
      el.localName,
      Array.from(el.attributes)
        .filter((item) => item.namespaceURI !== 'http://www.w3.org/2000/xmlns/')
        .map((item) => [
          item.namespaceURI,
          item.localName,
          item.localName === 'spid'
            ? drawings.get(item.value)
            : item.localName === 'id' && el.localName === 'cTn'
              ? clocks.get(item.value)
              : item.value,
        ])
        .sort(),
      el.children.length ? Array.from(el.children, visit) : el.textContent,
    ])
  return visit(root)
}

test('the ten default timing trees match the native PowerPoint captures', async () => {
  const result = await run(
    deckScript +
      `
const names = ${JSON.stringify(presetNames)}
names.forEach(addSlide)
const effects = names.map((effect,i) => ({slide:i+1,shape:'Badge',effect}))
saveFile('defaults.pptx', animatePptx(await write(), {effects}))`,
  )
  const parts = unzipSync(result.files[0].bytes)
  for (const [i, name] of presetNames.entries()) {
    const slide = parse(strFromU8(parts[part(i + 1)]))
    const timing = all(slide, 'timing')[0]
    const expected = parse(`<root xmlns:p="${p}">${await fixture(`pptx-animations/${name}.xml`).text()}</root>`)
    expect(canonical(timing)).toEqual(canonical(all(expected, 'timing')[0]))
    const ids = all(timing, 'cTn').map((el) => attr(el, 'id'))
    expect(new Set(ids).size).toBe(ids.length)
    const badge = all(slide, 'cNvPr').find((el) => attr(el, 'name') === 'Badge')!
    for (const node of [...all(timing, 'spTgt'), ...all(timing, 'bldP')]) {
      expect(attr(node, 'spid')).toBe(attr(badge, 'id'))
    }
  }
})

test('automatic entry, click stops, parallel delays, repeats and compound retiming', async () => {
  const result = await run(
    deckScript +
      `
addSlide()
const sequence = [
 {effect:'pulse', durationMs:501, start:'withPrevious', delayMs:100, repeat:3},
 {effect:'fadeIn', durationMs:900, start:'withPrevious'},
 {effect:'fadeOut', durationMs:301, start:'afterPrevious', delayMs:50},
 {effect:'blink', start:'onClick', repeat:'indefinite'},
 {effect:'spin', start:'withPrevious'},
 {effect:'appear', start:'onClick'}
]
saveFile('schedule.pptx', animatePptx(await write(), {effects:sequence.map(e => ({...e,slide:1,shape:'Badge'}))}))`,
  )
  const timing = all(parse(strFromU8(unzipSync(result.files[0].bytes)[part(1)])), 'timing')[0]
  const seq = all(timing, 'cTn').find((el) => attr(el, 'nodeType') === 'mainSeq')!
  const stops = Array.from(seq.children[0].children)
  const delay = (el: Element) => attr(all(el, 'cond')[0], 'delay')
  expect(stops.map(delay)).toEqual(['0', 'indefinite', 'indefinite'])
  const groups = Array.from(all(stops[0], 'childTnLst')[0].children)
  expect(groups.map(delay)).toEqual(['0', '1606'])
  const effects = all(timing, 'cTn').filter((el) => el.hasAttribute('presetID'))
  expect(effects.map(delay)).toEqual(['100', '0', '50', '0', '0', '0'])
  expect(effects.map((el) => attr(el, 'repeatCount'))).toEqual(['3000', null, null, 'indefinite', null, null])
  expect(delay(all(effects[2], 'set')[0])).toBe('300')
  expect(all(timing, 'bldP').map((el) => attr(el, 'grpId'))).toEqual(effects.map((el) => attr(el, 'grpId')))
  expect(new Set(effects.map((el) => attr(el, 'grpId'))).size).toBe(6)
})

test('shape and transition directions, speed and six transition elements', async () => {
  const result = await run(
    deckScript +
      `
const dirs = ['top','right','bottom','left']
const transitions = ['wipe','push','cover','wipe','zoom','zoom','fade','dissolve','push']
transitions.forEach(addSlide)
const effects = dirs.flatMap((direction,i) => ['flyIn','wipeIn'].map(effect => ({slide:i+1,shape:'Badge',direction,effect})))
saveFile('directions.pptx', animatePptx(await write(), {effects,transitions:transitions.map((effect,i) => {
 const transition = {slide:i+1,effect,speed:['fast','medium','slow'][i%3]}
 if(i<4) transition.direction = dirs[i]
 if(i===4) transition.direction = 'in'
 return transition
})}))`,
  )
  const parts = unzipSync(result.files[0].bytes)
  for (const [i, name] of ['wipe', 'push', 'cover', 'wipe', 'zoom', 'zoom', 'fade', 'dissolve', 'push'].entries()) {
    const slide = parse(strFromU8(parts[part(i + 1)]))
    const transition = all(slide, 'transition')[0]
    expect(attr(transition, 'spd')).toBe(['fast', 'med', 'slow'][i % 3])
    expect(transition.children[0].localName).toBe(name)
    expect(attr(transition.children[0], 'dir')).toBe(['d', 'l', 'u', 'r', 'in', 'out', null, null, 'l'][i])
    if (i >= 4) {
      continue
    }
    expect(
      all(slide, 'cTn')
        .filter((n) => n.hasAttribute('presetSubtype'))
        .map((n) => attr(n, 'presetSubtype')),
    ).toEqual([String(2 ** i), String(2 ** i)])
    expect(all(slide, 'animEffect')[0].getAttribute('filter')).toBe(`wipe(${['up', 'right', 'down', 'left'][i]})`)
    expect(all(slide, 'anim').map((el) => attr(all(el, 'strVal')[0], 'val'))).toEqual(
      [
        ['#ppt_x', '0-#ppt_h/2'],
        ['1+#ppt_w/2', '#ppt_y'],
        ['#ppt_x', '1+#ppt_h/2'],
        ['0-#ppt_w/2', '#ppt_y'],
      ][i],
    )
  }
})

const sampleInput = async () => new Uint8Array(await fixture('SampleShow.pptx').arrayBuffer())
test('resolve reordered slides and preserve every untargeted part of an uploaded deck', async () => {
  const parts = unzipSync(await sampleInput())
  const path = 'ppt/presentation.xml'
  parts[path] = strToU8(strFromU8(parts[path]).replace(/(<p:sldId [^>]+\/>)(<p:sldId [^>]+\/>)/, '$2$1'))
  const xml = strFromU8(parts[part(1)])
    .replace('</p:sld>', '<p:extLst/></p:sld>')
    .replaceAll('xmlns:p=', 'xmlns:slide=')
    .replace(/(<\/?)(?:p:)/g, '$1slide:')
    .replace('UTF-8', 'UTF-16')
  parts[part(1)] = Buffer.from('\uFEFF' + xml, 'utf16le')
  const input = zipSync(parts)
  const result = await run(
    `const original = readFile('sample.pptx')
const animated = animatePptx(original.buffer,{effects:[{slide:2,shape:'The Title',effect:'fadeIn'}]})
saveFile('out.pptx',animatePptx(animated,{transitions:[{slide:2,effect:'fade'}]}))`,
    [{ name: 'sample.pptx', bytes: input }],
  )
  const edited = unzipSync(result.files[0].bytes)
  expect(Object.keys(edited).sort()).toEqual(Object.keys(parts).sort())
  for (const path of Object.keys(parts)) {
    if (path !== part(1)) {
      expect(edited[path]).toEqual(parts[path])
    }
  }
  expect(Array.from(parse(strFromU8(edited[part(1)])).children).map((n) => n.localName)).toEqual([
    'cSld',
    'clrMapOvr',
    'transition',
    'timing',
    'extLst',
  ])
})

test('whole GIF picture and native table have no paragraph builds', async () => {
  const result = await run(
    deckScript +
      `
const s = pres.addSlide()
s.addImage({objectName:'GIF',data:'data:image/gif;base64,R0lGODlhAQABAIAAAP8AAAAAACH5BAAKAAAALAAAAAABAAEAAAICRAEAIfkEAAoAAAAsAAAAAAEAAQAAAgJMAQA7',x:1,y:1,w:1,h:1})
s.addTable([['Revenue']],{objectName:'Table',x:2,y:1,w:2,h:1})
s.addChart(pres.ChartType.bar,[{name:'North',labels:['Jan','Feb'],values:[4,6]}],{objectName:'Chart',x:1,y:3,w:4,h:2})
s.addNotes('Speaker notes')
addSlide()
const parts = fflate.unzipSync(await write())
const path = 'ppt/slides/slide1.xml'
// PptxGenJS reuses ID 2 for its first table. Give the source table its own ID.
parts[path] = fflate.strToU8(fflate.strFromU8(parts[path]).replace(/id="\\d+" name="Table"/,'id="99" name="Table"'))
const bytes = fflate.zipSync(parts)
saveFile('source.pptx',bytes)
saveFile('out.pptx',animatePptx(bytes,{effects:['GIF','Table'].map(name=>({slide:1,shape:name,effect:'fadeIn'}))}))`,
  )
  const [before, after] = result.files.map((file) => unzipSync(file.bytes))
  for (const path of Object.keys(before)) {
    if (path !== part(1)) {
      expect(after[path]).toEqual(before[path])
    }
  }
  const slide = parse(strFromU8(after[part(1)]))
  expect(all(slide, 'bldLst')).toHaveLength(0)
  expect(all(slide, 'cTn').some((el) => el.hasAttribute('grpId'))).toBe(false)
  expect(new Set(all(slide, 'spTgt').map((el) => attr(el, 'spid'))).size).toBe(2)
})

test('a partly visible group can animate as one object, while its nested member cannot', async () => {
  const result = await run(
    deckScript +
      `
addSlide()
const parts = fflate.unzipSync(await write())
const path = 'ppt/slides/slide1.xml'
const open = '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="23" name="Panel"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
 '<p:grpSpPr><a:xfrm><a:off x="-10000" y="0"/><a:ext cx="30000" cy="40000"/>' +
 '<a:chOff x="0" y="0"/><a:chExt cx="30000" cy="40000"/></a:xfrm></p:grpSpPr>'
parts[path] = fflate.strToU8(fflate.strFromU8(parts[path]).replace('<p:sp>',open+'<p:sp>').replace('</p:sp>','</p:sp></p:grpSp>'))
const bytes = fflate.zipSync(parts)
const animate = name => animatePptx(bytes,{effects:[{slide:1,shape:name,effect:'fadeIn'}]})
let reason
try { animate('Badge') } catch(error) { reason = error.message }
if(!reason?.includes('top-level')) throw Error('Expected a nested-target error, got '+reason)
saveFile('group.pptx',animate('Panel'))`,
  )
  const slide = parse(strFromU8(unzipSync(result.files[0].bytes)[part(1)]))
  expect(all(slide, 'spTgt').map((el) => attr(el, 'spid'))).toEqual(['23', '23'])
  expect(all(slide, 'bldLst')).toHaveLength(0)
})

test('refuse ambiguous targets, unsupported markup, occupied slots and unbounded schedules', async () => {
  const result = await run(
    deckScript +
      `
const s = addSlide()
s.addTable([['A']],{objectName:'Table',x:1,y:1,w:2,h:1})
s.addText('Other',{objectName:'Other',x:2,y:2,w:2,h:1})
s.addText('Off',{objectName:'Off',x:12,y:2,w:1,h:1})
const bytes = await write()
const effect = {slide:1,shape:'Other',effect:'blink'}
const transition = {slide:1,effect:'fade'}
const effects = (...entries) => ({effects:entries.map(e=>({...effect,...e}))})
const change = fn => {
 const parts = fflate.unzipSync(bytes), path='ppt/slides/slide1.xml'
 parts[path] = fflate.strToU8(fn(fflate.strFromU8(parts[path])))
 return fflate.zipSync(parts)
}
const cases = [
 [bytes,effects({shape:'Table'}),'Drawing ID'],
 [bytes,effects({shape:'Missing'}),'Available'],
 [bytes,effects({shape:'Off'}),'zero overlap'],
 [change(xml=>xml.replace('name="Badge"', 'name="Other"')),effects({}),'Ambiguous'],
 [change(xml=>xml.replace('</p:sld>','<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"/></p:sld>')),effects({}),'AlternateContent'],
 [bytes,effects({repeat:'indefinite'},{start:'withPrevious'},{start:'afterPrevious'}),'indefinite group'],
 [bytes,effects({repeat:0}),'integer'],
 [bytes,effects({repeat:4294968}),'repeatCount'],
 [bytes,effects({delayMs:4294967295}),'group end'],
 [bytes,effects({direction:'left'}),'Unknown option'],
 [bytes,effects({effect:'appear',durationMs:2}),'Unknown option'],
 [bytes,effects({effect:'disappear',repeat:3}),'Unknown option'],
 [bytes,{transitions:[transition,transition]},'duplicate'],
 [animatePptx(bytes,effects({})),effects({}),'existing timing'],
 [animatePptx(bytes,{transitions:[transition]}),{transitions:[transition]},'existing transition']
]
for(const [input,plan,reason] of cases) {
 let message = ''
 try { animatePptx(input,plan) } catch(error) { message = error.message }
 if(!message.includes(reason)) throw Error(reason+' expected, got '+message)
}
const junk = new Uint8Array([7])
const copy = animatePptx(junk,{})
if(copy===junk || copy[0]!==7) throw Error('Empty plan did not copy the original')
saveFile('ok.pptx', animatePptx(animatePptx(bytes,{transitions:[transition]}),effects({})))`,
  )
  expect(result.files.length).toBe(1)
})

test('the checker-only VM loads the XML globals without a presentation constructor', async () => {
  const rt = await runtime
  expect(rt.ooxmlLibrary).toContain('Copyright (c) 2026 Yuichiro Yamashita')
  const result = await runSandboxedScript(
    { ...rt, libraries: [] },
    {
      inputs: [],
      script: `
if ('animatePptx' in globalThis || 'PptxGenJS' in globalThis) throw Error('Unexpected script-only global')
new xmldom.DOMParser().parseFromString('<root/>','application/xml')`,
    },
  )
  expect(result.ok).toBe(true)
})
