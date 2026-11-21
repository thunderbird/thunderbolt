/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DOMParser, type Element, XMLSerializer } from '@xmldom/xmldom'
import { strToU8, zipSync } from 'fflate'
import { unzipWithinLimits } from '../files/unzip-within-limits'
import { sandboxLimits } from './constants'
import { resolvePart } from './formula-cache'
import { type Edge, edges, type Effect, presetBody, presets } from './pptx-animation-presets'

const p = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const a = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const r = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const rels = 'http://schemas.openxmlformats.org/package/2006/relationships'
const mc = 'http://schemas.openxmlformats.org/markup-compatibility/2006'
const p14 = 'http://schemas.microsoft.com/office/powerpoint/2010/main'
const parser = new DOMParser({
  normalizeLineEndings: (xml) => xml.replace(/\r\n?/g, '\n'),
  onError: (_level, message) => {
    throw new Error(message)
  },
})
const serializer = new XMLSerializer()
const children = (node: Element | undefined, ns: string, name: string) =>
  Array.from(node?.children ?? []).filter((el) => el.namespaceURI === ns && el.localName === name)
const child = (node: Element | undefined, ns: string, name: string) => children(node, ns, name)[0]
const uintMax = 0xffffffff

type Report = (message: string) => void
const reject: Report = (message) => {
  throw new Error(message)
}
const integer = (value: number, field: string, min = 0, report = reject) => {
  if (!Number.isInteger(value) || value < min || value > uintMax) {
    report(`${field} must be an integer from ${min} to ${uintMax}`)
  }
  return value
}

const options = (entry: Plan | Transition | Animation, allowed: string[], report = reject) => {
  if (Object.prototype.toString.call(entry) !== '[object Object]') {
    return report('Expected an options object')
  }
  const extra = Object.keys(entry).filter((key) => !allowed.includes(key))
  if (extra.length) {
    report(`Unknown option ${extra.join(', ')}. Choose from ${allowed.join(', ')}`)
  }
}

const choice = <T extends string>(value: T, allowed: readonly string[], field: string, report = reject) => {
  if (!allowed.includes(value)) {
    report(`${field} must be one of ${allowed.join(', ')}`)
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
  const coordinates = [off.getAttribute('x'), off.getAttribute('y'), ext.getAttribute('cx'), ext.getAttribute('cy')]
  if (!coordinates.every((value) => /^[+-]?\d+$/.test(value ?? ''))) {
    return
  }
  const [x, y, w, h] = coordinates.map(Number)
  // A straight line has no width or no height, so a side of 0 still covers the line it draws.
  const inside = x < canvas.width && y < canvas.height && x + Math.max(w, 1) > 0 && y + Math.max(h, 1) > 0
  if (!(w >= 0 && h >= 0 && w + h > 0 && inside)) {
    throw new Error(
      'Target has zero overlap with the slide canvas. Move its rectangle onto the slide or choose another object.',
    )
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
        .join(
          ', ',
        )}. Name the shape where the script adds it, e.g. slide.addText(text, { objectName: 'title', ... }), and use that name here.`,
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
    ['videoFile', 'audioFile', 'quickTimeFile', 'wavAudioFile', 'audioCd'].some((name) =>
      child(applicationProps, a, name),
    ) ||
    applicationProps?.getElementsByTagNameNS(p14, 'media').length
  ) {
    throw new Error('Media playback targets require raw XML')
  }
  const props = child(object, p, kind === 'grpSp' ? 'grpSpPr' : 'spPr')
  checkBounds(object, props, canvas)
  const text =
    kind === 'sp' &&
    Array.from(child(object, p, 'txBody')?.getElementsByTagNameNS(a, 't') ?? []).some((el) => el.textContent?.length)
  return { id, text }
}

/** Validate independent plan fields even when another field or the referenced slide is invalid. */
const validateAnimation = (entry: Animation, report: Report) => {
  const { effect, start = 'onClick', delayMs = 0, direction = 'bottom', repeat = 1 } = entry
  choice(effect, Object.keys(presets), 'effect', report)
  const timed = effect !== 'appear' && effect !== 'disappear'
  const directional = effect === 'flyIn' || effect === 'wipeIn'
  options(
    entry,
    [
      'slide',
      targetNameKey,
      'effect',
      'start',
      'delayMs',
      ...(timed ? ['durationMs', 'repeat'] : []),
      ...(directional ? ['direction'] : []),
    ],
    report,
  )
  choice(start, ['onClick', 'withPrevious', 'afterPrevious'], 'start', report)
  choice(direction, Object.keys(edges), 'direction', report)
  integer(delayMs, 'delayMs', 0, report)
  if (entry.durationMs !== undefined) {
    integer(entry.durationMs, 'durationMs', 1, report)
  }
  if (repeat !== 'indefinite') {
    integer(repeat, 'repeat', 1, (message) => report(`${message}, or 'indefinite' to loop`))
    if (repeat > uintMax / 1000) {
      report(`repeatCount exceeds ${uintMax}. Use at most ${Math.floor(uintMax / 1000)} plays.`)
    }
  }
}
type Indexed<T> = { entry: T; index: number; valid: boolean }
type Group = { id: number; offset: number; effects: string[] }
type Stop = { id: number; click: boolean; groups: Group[] }
const delayCondition = (delay: string | number) => `<p:stCondLst><p:cond delay="${delay}"/></p:stCondLst>`
const parallel = (id: number, delay: number | string, nodes: string) =>
  `<p:par><p:cTn id="${id}" fill="hold">${delayCondition(delay)}<p:childTnLst>${nodes}</p:childTnLst></p:cTn></p:par>`

/** Each click stop has its own clock. Groups within it start at the preceding group's latest end. */
const buildSlideTiming = (slide: Element, effects: Indexed<Animation>[], canvas: Canvas, errors: string[]) => {
  let lastId = 2
  const nextId = () => ++lastId
  const stops: Stop[] = []
  const builds: string[] = []
  let finiteEnd = 0
  let loopEnd = 0
  for (const { entry, index, valid } of effects) {
    try {
      const { effect, durationMs, start = 'onClick', delayMs = 0, repeat = 1, direction = 'bottom' } = entry
      const target = resolveAnimationTarget(slide, entry[targetNameKey], canvas)
      if (!valid) {
        continue
      }
      const directional = effect === 'flyIn' || effect === 'wipeIn'
      const duration = durationMs ?? presets[effect].duration
      const count = repeat === 'indefinite' ? repeat : repeat * 1000
      const newStop = !stops.length || start === 'onClick'
      const newGroup = newStop || start === 'afterPrevious'
      const groups = stops.at(-1)?.groups
      const offset = newStop ? 0 : newGroup ? finiteEnd || loopEnd : groups!.at(-1)!.offset
      const begin = integer(offset + delayMs, 'start offset')
      const end = integer(begin + duration * (repeat === 'indefinite' ? 1 : repeat), 'group end')
      if (newStop) {
        stops.push({ id: nextId(), click: start === 'onClick', groups: [] })
      }
      const stop = stops[stops.length - 1]
      if (newGroup) {
        stop.groups.push({ id: nextId(), offset, effects: [] })
        finiteEnd = 0
        loopEnd = 0
      }
      const group = stop.groups[stop.groups.length - 1]
      if (repeat === 'indefinite') {
        loopEnd = Math.max(loopEnd, end)
      } else {
        finiteEnd = Math.max(finiteEnd, end)
      }
      const grpId = target.text ? ` grpId="${builds.length}"` : ''
      if (target.text) {
        builds.push(`<p:bldP spid="${target.id}"${grpId} animBg="1"/>`)
      }
      const repeatAttr = repeat === 1 ? '' : ` repeatCount="${count}"`
      const nodeType = { onClick: 'clickEffect', withPrevious: 'withEffect', afterPrevious: 'afterEffect' }[start]
      const preset = presets[effect]
      group.effects.push(
        `<p:par><p:cTn id="${nextId()}" presetID="${preset.id}" presetClass="${preset.cls}" presetSubtype="${directional ? edges[direction].subtype : 0}" fill="hold"${grpId}${repeatAttr} nodeType="${nodeType}">${delayCondition(delayMs)}<p:childTnLst>${presetBody(effect, direction, duration, target.id, nextId)}</p:childTnLst></p:cTn></p:par>`,
      )
    } catch (error) {
      errors.push(entryError('effects', index, entry, error instanceof Error ? error.message : String(error)))
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

const transitionXml = (entry: Transition, report: Report) => {
  const { effect, speed = 'medium' } = entry
  choice(effect, ['fade', 'wipe', 'push', 'zoom', 'cover', 'dissolve'], 'effect', report)
  choice(speed, ['fast', 'medium', 'slow'], 'speed', report)
  const edge = ['wipe', 'push', 'cover'].includes(effect)
  options(entry, ['slide', 'effect', 'speed', ...(edge || effect === 'zoom' ? ['direction'] : [])], report)
  const { direction: requested = edge ? 'right' : 'out' } = entry
  const direction = edge
    ? edges[choice(requested, Object.keys(edges), 'direction', report) as Edge]?.travel
    : effect === 'zoom'
      ? choice(requested, ['in', 'out'], 'direction', report)
      : undefined
  return `<p:transition xmlns:p="${p}" spd="${speed === 'medium' ? 'med' : speed}"><p:${effect}${direction ? ` dir="${direction}"` : ''}/></p:transition>`
}

const slots = ['cSld', 'clrMapOvr', 'transition', 'timing', 'extLst']
const slideSlot = (node: Element) => {
  if (node.namespaceURI === p) {
    return node.localName
  }
  const branches = Array.from(node.children)
  if (
    node.namespaceURI === mc &&
    node.localName === 'AlternateContent' &&
    branches.length &&
    branches.every(
      (branch) =>
        branch.namespaceURI === mc &&
        ['Choice', 'Fallback'].includes(branch.localName ?? '') &&
        branch.children.length === 1 &&
        child(branch, p, 'transition'),
    )
  ) {
    return 'transition'
  }
  return null
}

const entryError = (
  kind: keyof Plan,
  index: number,
  entry: { slide: number; [targetNameKey]?: string },
  message: string,
) => {
  const name = kind === 'effects' ? `, shape ${JSON.stringify(entry?.[targetNameKey])}` : ''
  return `${kind}[${index}], slide ${entry?.slide}${name}: ${message}`
}
const insertSlot = (slide: Element, name: string, xml: string) => {
  const doc = slide.ownerDocument!
  const node = parser.parseFromString(xml, 'application/xml').documentElement!
  const before = Array.from(slide.children).find((el) => slots.indexOf(slideSlot(el) ?? '') > slots.indexOf(name))
  slide.insertBefore(doc.importNode(node, true), before ?? null)
}

/** Add whole-object PowerPoint animations and slide transitions to the specified presentation-order slides. */
export const animatePptx = (bytes: Uint8Array | ArrayBuffer, plan: Plan): Uint8Array => {
  const errors: string[] = []
  options(plan, ['effects', 'transitions'], (message) => errors.push(message))
  if (!(bytes instanceof ArrayBuffer || bytes instanceof Uint8Array)) {
    throw new Error('Expected PPTX bytes')
  }
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  const edits = new Map<
    number,
    { effects: Indexed<Animation>[]; transitions: (Indexed<Transition> & { xml: string })[] }
  >()
  for (const kind of ['effects', 'transitions'] as const) {
    const entries = plan?.[kind] === undefined ? [] : plan[kind]
    if (!Array.isArray(entries)) {
      errors.push(`${kind} must be an array`)
      continue
    }
    for (const [index, entry] of entries.entries()) {
      const report = (message: string) => errors.push(entryError(kind, index, entry, message))
      if (Object.prototype.toString.call(entry) !== '[object Object]') {
        report('Expected an options object with a slide number')
        continue
      }
      const ordinal = integer(entry.slide, 'slide', 1, report)
      const before = errors.length
      const edit = edits.get(ordinal) ?? { effects: [], transitions: [] }
      if (kind === 'effects') {
        validateAnimation(entry as Animation, report)
        edit.effects.push({ entry: entry as Animation, index, valid: errors.length === before })
      } else {
        const xml = transitionXml(entry as Transition, report)
        if (edit.transitions.length) {
          report(
            `This transition is a duplicate of transitions[${edit.transitions[0].index}]. Keep one transition per slide.`,
          )
        }
        edit.transitions.push({ entry: entry as Transition, index, xml, valid: before === errors.length })
      }
      if (Number.isInteger(ordinal) && ordinal >= 1 && ordinal <= uintMax) {
        edits.set(ordinal, edit)
      }
    }
  }
  if (!edits.size) {
    if (errors.length) {
      throw new Error(errors.join('\n'))
    }
    return input.slice()
  }
  const parts = unzipWithinLimits(input, { bytes: sandboxLimits.unzipBytes, parts: 0xffff })
  const rootRels = relationships(parts, '')
  if (rootRels.some((el) => el.getAttribute('Type')?.endsWith('/digital-signature/origin'))) {
    throw new Error('Editing this signed presentation would invalidate its signature')
  }
  if (
    rootRels.some(
      (el) => el.getAttribute('Type') === 'http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument',
    )
  ) {
    throw new Error('Strict PPTX requires raw XML. Use fflate and xmldom to edit this presentation.')
  }
  const presentation = relatedPart(
    parts,
    '',
    rootRels.filter((el) => el.getAttribute('Type') === r + '/officeDocument'),
    'officeDocument',
  )
  const deck = readXml(parts, presentation)
  const links = relationships(parts, presentation)
  const list = child(deck, p, 'sldIdLst')
  if (child(list, mc, 'AlternateContent')) {
    throw new Error('Unresolved mc:AlternateContent in p:sldIdLst. Use raw XML to resolve slide order.')
  }
  const slides = children(list, p, 'sldId')
  const size = child(deck, p, 'sldSz')
  const canvas = {
    width: Number(size?.getAttribute('cx') ?? 9144000),
    height: Number(size?.getAttribute('cy') ?? 6858000),
  }
  for (const [ordinal, edit] of edits) {
    try {
      const id = slides[ordinal - 1]?.getAttributeNS(r, 'id')
      if (!id) {
        throw new Error(`Missing slide ${ordinal}. Choose a slide from 1 to ${slides.length}.`)
      }
      const path = relatedPart(
        parts,
        presentation,
        links.filter((el) => el.getAttribute('Id') === id),
        'slide',
      )
      const slide = readXml(parts, path)
      const nodes = Array.from(slide.children)
      let previous = -1
      if (slide.namespaceURI !== p || slide.localName !== 'sld' || nodes[0]?.localName !== 'cSld') {
        throw new Error('Expected a slide with cSld')
      }
      for (const node of nodes) {
        const slot = slots.indexOf(slideSlot(node) ?? '')
        if (slot <= previous) {
          throw new Error(`Unsupported or misplaced slide child ${node.nodeName}`)
        }
        previous = slot
      }
      for (const { entry, index, xml, valid } of edit.transitions) {
        if (nodes.some((node) => slideSlot(node) === 'transition')) {
          errors.push(
            entryError('transitions', index, entry, 'Slide has an existing transition. Use raw XML to edit it.'),
          )
        } else if (valid) {
          insertSlot(slide, 'transition', xml)
        }
      }
      if (edit.effects.length) {
        const timing = buildSlideTiming(slide, edit.effects, canvas, errors)
        if (child(slide, p, 'timing')) {
          for (const { entry, index } of edit.effects) {
            errors.push(entryError('effects', index, entry, 'Slide has existing timing. Use raw XML to edit it.'))
          }
        } else {
          insertSlot(slide, 'timing', timing)
        }
      }
      if (!errors.length) {
        // XML 1.0 readers normalize a literal CR. Only character references survived input normalization.
        parts.set(path, strToU8(serializer.serializeToString(slide.ownerDocument!).replace(/\r/g, '&#xD;')))
      }
    } catch (error) {
      for (const kind of ['effects', 'transitions'] as const) {
        for (const { entry, index } of edit[kind]) {
          errors.push(entryError(kind, index, entry, error instanceof Error ? error.message : String(error)))
        }
      }
    }
  }
  if (errors.length) {
    throw new Error(errors.join('\n'))
  }
  return zipSync(
    Object.fromEntries(
      Array.from(parts, ([name, data]) => [
        name,
        /\.(?:png|jpe?g|gif|webp|avif|mp[34]|m4[av]|mov|ogg|wm[av]|zip|xlsx)$/i.test(name)
          ? [data, { level: 0 }]
          : data,
      ]),
    ),
  )
}
