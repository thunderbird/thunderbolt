/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DOMParser, type Element, XMLSerializer } from '@xmldom/xmldom'
import { strToU8, zipSync } from 'fflate'
import { unzipWithinLimits } from '../files/unzip-within-limits'
import { sandboxLimits } from './constants'
import { resolvePart } from './formula-cache'
import { type Edge, edges, type Effect, presetBody, presets, pulseHalf } from './pptx-animation-presets'

const p = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const a = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const r = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const rels = 'http://schemas.openxmlformats.org/package/2006/relationships'
const parser = new DOMParser({
  onError: (_level, message) => {
    throw new Error(message)
  },
})
const serializer = new XMLSerializer()
const children = (node: Element | undefined, ns: string, name: string) =>
  Array.from(node?.children ?? []).filter((el) => el.namespaceURI === ns && el.localName === name)
const child = (node: Element | undefined, ns: string, name: string) => children(node, ns, name)[0]
const uintMax = 0xffffffff

const integer = (value: number, field: string, min = 0) => {
  if (!Number.isInteger(value) || value < min || value > uintMax) {
    throw new Error(`${field} must be an integer from ${min} to ${uintMax}`)
  }
  return value
}

const options = (entry: Plan | Transition | Animation, allowed: string[]) => {
  if (Object.prototype.toString.call(entry) !== '[object Object]') {
    throw new Error('Expected an options object')
  }
  const extra = Object.keys(entry).find((key) => !allowed.includes(key))
  if (extra !== undefined) {
    throw new Error(`Unknown option ${extra}. Choose from ${allowed.join(', ')}`)
  }
}

const choice = <T extends string>(value: T, allowed: readonly string[], field: string) => {
  if (!allowed.includes(value)) {
    throw new Error(`${field} must be one of ${allowed.join(', ')}`)
  }
  return value
}

const targetNameKey = 'shape'
type Animation = {
  slide: number
  [targetNameKey]: string
  effect: Effect
  start?: 'onClick' | 'withPrevious' | 'afterPrevious'
  delayMs?: number
  durationMs?: number
  repeat?: number | 'indefinite'
  direction?: Edge
}
type Transition = {
  slide: number
  effect: 'fade' | 'wipe' | 'push' | 'zoom' | 'cover' | 'dissolve'
  direction?: Edge | 'in' | 'out'
  speed?: 'fast' | 'medium' | 'slow'
}
type Plan = { effects?: Animation[]; transitions?: Transition[] }

const readXml = (parts: Map<string, Uint8Array>, path: string) => {
  const bytes = parts.get(path)
  if (!bytes) {
    throw new Error(`Missing package part ${path}`)
  }
  const bom = (bytes[0] << 8) | bytes[1]
  const encoding = bom === 0xfffe ? 'utf-16le' : bom === 0xfeff ? 'utf-16be' : 'utf-8'
  const xml = new TextDecoder(encoding, { fatal: true }).decode(bytes)
  // Edited parts are always serialized as UTF-8. Avoid carrying a UTF-16 declaration into the output.
  const normalized = xml.replace(
    /^(<\?xml\s[^?]*?\sencoding\s*=\s*)(["'])(.*?)\2/i,
    (_, prefix, quote, name: string) => {
      if (name.toLowerCase() !== encoding.slice(0, 6)) {
        throw new Error(`Unsupported encoding ${name} in ${path}`)
      }
      return prefix + quote + 'UTF-8' + quote
    },
  )
  return parser.parseFromString(normalized, 'application/xml').documentElement!
}

const relationships = (parts: Map<string, Uint8Array>, owner: string) => {
  const slash = owner.lastIndexOf('/') + 1
  const path = owner.slice(0, slash) + '_rels/' + owner.slice(slash) + '.rels'
  return children(readXml(parts, path), rels, 'Relationship')
}

const relatedPart = (parts: Map<string, Uint8Array>, owner: string, matches: Element[], type: string) => {
  const [rel] = matches
  if (
    matches.length !== 1 ||
    rel.getAttribute('Type') !== r + '/' + type ||
    (rel.hasAttribute('TargetMode') && rel.getAttribute('TargetMode') !== 'Internal')
  ) {
    throw new Error(`Expected one internal ${type} relationship in ${owner || 'package'}`)
  }
  const path = resolvePart(owner, rel.getAttribute('Target') ?? '')
  if (!parts.has(path)) {
    throw new Error(`Missing ${type} part ${path}`)
  }
  return path
}

type Canvas = { width: number; height: number }
const checkBounds = (object: Element, props: Element | undefined, canvas: Canvas) => {
  const transform = child(object, p, 'xfrm') ?? child(props, a, 'xfrm')
  const off = child(transform, a, 'off')
  const ext = child(transform, a, 'ext')
  if (!off || !ext) {
    return
  }
  const x = Number(off.getAttribute('x'))
  const y = Number(off.getAttribute('y'))
  const w = Number(ext.getAttribute('cx'))
  const h = Number(ext.getAttribute('cy'))
  if (!(w > 0 && h > 0 && x < canvas.width && y < canvas.height && x + w > 0 && y + h > 0)) {
    throw new Error('Target has zero overlap with the slide canvas')
  }
}

/** Resolve names across the slide, then check the numeric ID PowerPoint actually uses for timing. */
const resolveAnimationTarget = (slide: Element, name: string, canvas: Canvas) => {
  const drawings = Array.from(slide.getElementsByTagNameNS(p, 'cNvPr'))
  const matches = drawings.filter((el) => el.getAttribute('name') === name)
  if (matches.length !== 1 || !name) {
    throw new Error(
      `${matches.length ? 'Ambiguous or empty' : 'Missing'} shape name. Available: ${drawings
        .slice(0, 20)
        .map((el) => el.getAttribute('name'))
        .join(', ')}`,
    )
  }
  const [nv] = matches
  const rawId = nv.getAttribute('id') ?? ''
  if (!/^\d+$/.test(rawId)) {
    throw new Error('Missing or invalid drawing ID')
  }
  const id = integer(Number(rawId), 'drawing ID')
  const other = drawings.find((el) => el !== nv && el.hasAttribute('id') && Number(el.getAttribute('id')) === id)
  if (other) {
    throw new Error(
      `Drawing ID ${id} also belongs to "${other.getAttribute('name')}". Choose a uniquely numbered target or correct the source drawings.`,
    )
  }
  const object = nv.parentNode?.parentNode as Element
  const tree = child(child(slide, p, 'cSld'), p, 'spTree')
  if (object.parentNode !== tree) {
    throw new Error('Only top-level objects can be animated, including a whole group')
  }
  const kind = object.localName ?? ''
  const graphic = child(child(object, a, 'graphic'), a, 'graphicData')
  if (
    object.namespaceURI !== p ||
    !['sp', 'pic', 'grpSp', 'graphicFrame'].includes(kind) ||
    (kind === 'graphicFrame' && !child(graphic, a, 'tbl'))
  ) {
    throw new Error('Supported targets are shapes, pictures, whole groups and native tables')
  }
  const nvName = { sp: 'nvSpPr', pic: 'nvPicPr', grpSp: 'nvGrpSpPr', graphicFrame: 'nvGraphicFramePr' }[kind]
  if (nv.parentNode !== child(object, p, nvName!)) {
    throw new Error('Unsupported nonvisual drawing properties')
  }
  const applicationProps = child(nv.parentNode as Element, p, 'nvPr')
  if (
    Array.from(applicationProps?.children ?? []).some((el) =>
      ['videoFile', 'audioFile', 'quickTimeFile', 'wavAudioFile', 'audioCd'].includes(el.localName ?? ''),
    ) ||
    applicationProps?.getElementsByTagNameNS('*', 'media').length
  ) {
    throw new Error('Media playback targets require raw XML')
  }
  const props = child(object, p, kind === 'grpSp' ? 'grpSpPr' : 'spPr')
  checkBounds(object, props, canvas)
  const text =
    kind === 'sp' &&
    Array.from(child(object, p, 'txBody')?.getElementsByTagNameNS(a, 't') ?? []).some((el) => el.textContent?.length)
  const style = child(object, p, 'style')
  const painted = (properties: Element | undefined, ref: string) => {
    const fill = Array.from(properties?.children ?? []).find(
      (el) =>
        el.namespaceURI === a &&
        ['solidFill', 'gradFill', 'pattFill', 'blipFill', 'grpFill', 'noFill'].includes(el.localName ?? ''),
    )
    return fill ? fill.localName !== 'noFill' : Number(child(style, a, ref)?.getAttribute('idx') ?? 0) > 0
  }
  const background = painted(props, 'fillRef') || painted(child(props, a, 'ln'), 'lnRef')
  return { id, text, background }
}

type Indexed<T> = { entry: T; index: number }
type Group = { id: number; offset: number; effects: string[] }
type Stop = { id: number; click: boolean; groups: Group[] }
const delayCondition = (delay: string | number) => `<p:stCondLst><p:cond delay="${delay}"/></p:stCondLst>`
const parallel = (id: number, delay: number | string, nodes: string) =>
  `<p:par><p:cTn id="${id}" fill="hold">${delayCondition(delay)}<p:childTnLst>${nodes}</p:childTnLst></p:cTn></p:par>`

/** Each click stop has its own clock. Groups within it start at the preceding group's latest end. */
const buildSlideTiming = (slide: Element, effects: Indexed<Animation>[], canvas: Canvas) => {
  let lastId = 2
  const nextId = () => ++lastId
  const stops: Stop[] = []
  const builds: string[] = []
  let groupEnd = 0
  for (const { entry, index } of effects) {
    try {
      const { effect, durationMs, start = 'onClick', delayMs = 0, repeat = 1, direction = 'bottom' } = entry
      choice(effect, Object.keys(presets), 'effect')
      const directional = effect === 'flyIn' || effect === 'wipeIn'
      const timed = presets[effect].duration > 1
      options(entry, [
        'slide',
        targetNameKey,
        'effect',
        'start',
        'delayMs',
        ...(timed ? ['durationMs', 'repeat'] : []),
        ...(directional ? ['direction'] : []),
      ])
      choice(start, ['onClick', 'withPrevious', 'afterPrevious'], 'start')
      choice(direction, Object.keys(edges), 'direction')
      integer(delayMs, 'delayMs')
      const duration = integer(durationMs === undefined ? presets[effect].duration : durationMs, 'durationMs', 1)
      const cycle = effect === 'pulse' ? integer(Math.max(duration, 2 * pulseHalf(duration)), 'pulse cycle') : duration
      const count = repeat === 'indefinite' ? repeat : integer(integer(repeat, 'repeat', 1) * 1000, 'repeatCount')
      const target = resolveAnimationTarget(slide, entry[targetNameKey], canvas)
      if (!stops.length || start === 'onClick') {
        stops.push({ id: nextId(), click: start === 'onClick', groups: [] })
        groupEnd = 0
      }
      const stop = stops[stops.length - 1]
      if (!stop.groups.length || start === 'afterPrevious') {
        if (!Number.isFinite(groupEnd)) {
          throw new Error('After an indefinite group, use withPrevious or a new onClick')
        }
        stop.groups.push({ id: nextId(), offset: groupEnd, effects: [] })
      }
      const group = stop.groups[stop.groups.length - 1]
      const begin = integer(group.offset + delayMs, 'start offset')
      const end = repeat === 'indefinite' ? Infinity : integer(begin + cycle * repeat, 'group end')
      groupEnd = Math.max(groupEnd, end)
      const grpId = target.text ? ` grpId="${builds.length}"` : ''
      if (target.text) {
        builds.push(`<p:bldP spid="${target.id}"${grpId}${target.background ? ' animBg="1"' : ''}/>`)
      }
      const repeatAttr = repeat === 1 ? '' : ` repeatCount="${count}"`
      const nodeType = { onClick: 'clickEffect', withPrevious: 'withEffect', afterPrevious: 'afterEffect' }[start]
      const preset = presets[effect]
      group.effects.push(
        `<p:par><p:cTn id="${nextId()}" presetID="${preset.id}" presetClass="${preset.cls}" presetSubtype="${directional ? edges[direction].subtype : 0}" fill="hold"${grpId}${repeatAttr} nodeType="${nodeType}">${delayCondition(delayMs)}<p:childTnLst>${presetBody(effect, direction, duration, target.id, nextId)}</p:childTnLst></p:cTn></p:par>`,
      )
    } catch (error) {
      throw new Error(
        `effects[${index}], ${JSON.stringify(entry[targetNameKey])}: ${error instanceof Error ? error.message : error}`,
        { cause: error },
      )
    }
  }
  const sequence = stops
    .map((stop) =>
      parallel(
        stop.id,
        stop.click ? 'indefinite' : 0,
        stop.groups.map((group) => parallel(group.id, group.offset, group.effects.join(''))).join(''),
      ),
    )
    .join('')
  const navigation = (list: string, event: string) =>
    `<p:${list}><p:cond evt="${event}" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:${list}>`
  const main = `<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>${sequence}</p:childTnLst></p:cTn>${navigation('prevCondLst', 'onPrev')}${navigation('nextCondLst', 'onNext')}</p:seq>`
  return `<p:timing xmlns:p="${p}"><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>${main}</p:childTnLst></p:cTn></p:par></p:tnLst>${builds.length ? '<p:bldLst>' + builds.join('') + '</p:bldLst>' : ''}</p:timing>`
}

const transitionXml = (entry: Transition) => {
  const { effect, speed = 'medium' } = entry
  choice(effect, ['fade', 'wipe', 'push', 'zoom', 'cover', 'dissolve'], 'effect')
  choice(speed, ['fast', 'medium', 'slow'], 'speed')
  const edge = ['wipe', 'push', 'cover'].includes(effect)
  options(entry, ['slide', 'effect', 'speed', ...(edge || effect === 'zoom' ? ['direction'] : [])])
  const { direction: requested = edge ? 'right' : 'out' } = entry
  const direction = edge
    ? edges[choice(requested, Object.keys(edges), 'direction') as Edge].travel
    : effect === 'zoom'
      ? choice(requested, ['in', 'out'], 'direction')
      : undefined
  return `<p:transition xmlns:p="${p}" spd="${speed === 'medium' ? 'med' : speed}"><p:${effect}${direction ? ` dir="${direction}"` : ''}/></p:transition>`
}

const slots = ['cSld', 'clrMapOvr', 'transition', 'timing', 'extLst']
const insertSlot = (slide: Element, name: string, xml: string) => {
  const doc = slide.ownerDocument!
  const node = parser.parseFromString(xml, 'application/xml').documentElement!
  const before = Array.from(slide.children).find((el) => slots.indexOf(el.localName ?? '') > slots.indexOf(name))
  slide.insertBefore(doc.importNode(node, true), before ?? null)
}

/** Add whole-object PowerPoint animations and slide transitions to the specified presentation-order slides. */
export const animatePptx = (bytes: Uint8Array | ArrayBuffer, plan: Plan): Uint8Array => {
  options(plan, ['effects', 'transitions'])
  if (!(bytes instanceof ArrayBuffer || bytes instanceof Uint8Array)) {
    throw new Error('Expected PPTX bytes')
  }
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const edits = new Map<number, { effects: Indexed<Animation>[]; transitions: Indexed<Transition>[] }>()
  for (const kind of ['effects', 'transitions'] as const) {
    const entries = plan[kind] === undefined ? [] : plan[kind]
    if (!Array.isArray(entries)) {
      throw new Error(`${kind} must be an array`)
    }
    for (const [index, entry] of entries.entries()) {
      const ordinal = integer(entry?.slide, `${kind}[${index}].slide`, 1)
      const edit = edits.get(ordinal) ?? { effects: [], transitions: [] }
      if (kind === 'effects') {
        edit.effects.push({ entry: entry as Animation, index })
      } else {
        edit.transitions.push({ entry: entry as Transition, index })
      }
      edits.set(ordinal, edit)
    }
  }
  if (!edits.size) {
    return input.slice()
  }
  const parts = unzipWithinLimits(input, { bytes: sandboxLimits.unzipBytes, parts: 0xffff })
  const rootRels = relationships(parts, '')
  if (rootRels.some((el) => el.getAttribute('Type')?.endsWith('/digital-signature/origin'))) {
    throw new Error('Editing this signed presentation would invalidate its signature')
  }
  const presentation = relatedPart(
    parts,
    '',
    rootRels.filter((el) => el.getAttribute('Type') === r + '/officeDocument'),
    'officeDocument',
  )
  const deck = readXml(parts, presentation)
  const links = relationships(parts, presentation)
  const slides = children(child(deck, p, 'sldIdLst'), p, 'sldId')
  const size = child(deck, p, 'sldSz')
  const canvas = { width: Number(size?.getAttribute('cx')), height: Number(size?.getAttribute('cy')) }
  for (const [ordinal, edit] of edits) {
    const id = slides[ordinal - 1]?.getAttributeNS(r, 'id')
    if (!id) {
      throw new Error(`Missing slide ${ordinal} in ${presentation}`)
    }
    const path = relatedPart(
      parts,
      presentation,
      links.filter((el) => el.getAttribute('Id') === id),
      'slide',
    )
    try {
      const slide = readXml(parts, path)
      const nodes = Array.from(slide.children)
      let previous = -1
      if (slide.namespaceURI !== p || slide.localName !== 'sld' || nodes[0]?.localName !== 'cSld') {
        throw new Error('Expected a slide with cSld')
      }
      for (const node of nodes) {
        const slot = slots.indexOf(node.localName ?? '')
        if (node.namespaceURI !== p || slot <= previous) {
          throw new Error(`Unsupported or misplaced slide child ${node.nodeName}`)
        }
        previous = slot
      }
      if (edit.transitions.length) {
        const { entry, index } = edit.transitions[0]
        if (edit.transitions.length > 1 || child(slide, p, 'transition')) {
          throw new Error(`transitions[${index}]: duplicate or existing transition`)
        }
        insertSlot(slide, 'transition', transitionXml(entry))
      }
      if (edit.effects.length) {
        if (child(slide, p, 'timing')) {
          throw new Error('Slide already has existing timing')
        }
        insertSlot(slide, 'timing', buildSlideTiming(slide, edit.effects, canvas))
      }
      parts.set(path, strToU8(serializer.serializeToString(slide.ownerDocument!)))
    } catch (error) {
      throw new Error(`Slide ${ordinal}, ${path}: ${error instanceof Error ? error.message : error}`, { cause: error })
    }
  }
  return zipSync(Object.fromEntries(parts))
}
