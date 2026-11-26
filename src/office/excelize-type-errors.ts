/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from 'zod'
import type { Excelize, ExcelizeFile } from './excelize-engine'
import { functionsOf, type WorkbookFunction, type WorkbookValue } from './workbook-bridge'

/** The whole error Excelize returns when an argument, or a field inside one, has the wrong type. */
const typeError = 'invalid argument data type'

const typeFailure = z.object({ error: z.literal(typeError) })

/** Each probe is one more Excelize call, so a failed call over a large array stops searching after this many. */
const maxProbes = 200

/** One value of each kind Excelize converts, to find the kind a rejected value should have had. */
const samples: WorkbookValue[] = ['', 0, false, [], {}]

// Bytes before objects: a Uint8Array would also pass as a record of its indexes.
const kinds = [
  ['a string', z.string()],
  ['a number', z.number()],
  ['a boolean', z.boolean()],
  ['null', z.null()],
  ['undefined', z.undefined()],
  ['bytes', z.instanceof(Uint8Array)],
  ['an array', z.array(z.unknown())],
] as const

/** A value's kind, in words, for a message. */
const kindOf = (value: WorkbookValue) => kinds.find(([, schema]) => schema.safeParse(value).success)?.[0] ?? 'an object'

const isContainer = (value: WorkbookValue): value is WorkbookValue[] | { [key: string]: WorkbookValue } =>
  kindOf(value) === 'an array' || kindOf(value) === 'an object'

/**
 * Which value of a call's arguments Excelize rejected for its type, and the kinds it takes there, such as
 * `argument 3.Series[0].Name is a number, where Excelize takes a string`. Found by calling `probe` with one value at a
 * time swapped for a sample of each kind: the value whose swap makes the call pass is the wrong one. Excelize checks
 * every type before it does anything, but a probe that passes does run, so `probe` must be the same function on a
 * workbook it is safe to change. With more than one wrong value no single swap passes, and the message lists the
 * arguments' kinds instead.
 */
export const describeTypeError = (probe: WorkbookFunction, args: WorkbookValue[]) => {
  let probes = 0
  // Excelize checks the type of each argument and field, but not of an array's items: an item of another kind can
  // crash it. So an item is never swapped, only the fields of an object inside it.
  const explain = (
    value: WorkbookValue,
    path: string,
    rejects: (value: WorkbookValue) => boolean,
    swappable = true,
  ): string[] => {
    const inside = isContainer(value)
      ? Object.entries(value).flatMap(([key, child]) => {
          if (!Array.isArray(value)) {
            return explain(child, `${path}.${key}`, (inner) => rejects({ ...value, [key]: inner }))
          }
          return kindOf(child) === 'an object'
            ? explain(child, `${path}[${key}]`, (inner) => rejects(value.with(Number(key), inner)), false)
            : []
        })
      : []
    if (inside.length > 0 || !swappable) {
      return inside
    }
    const takes = samples.filter((sample) => !rejects(sample)).map(kindOf)
    return takes.length > 0 ? [`${path} is ${kindOf(value)}, where Excelize takes ${takes.join(' or ')}`] : []
  }
  const found = args.flatMap((arg, index) =>
    // Out of probes counts as still failing, so a value that was fine is never named.
    explain(
      arg,
      `argument ${index + 1}`,
      (value) => ++probes > maxProbes || typeFailure.safeParse(probe(...args.with(index, value))).success,
    ),
  )
  return found.length > 0 ? found.slice(0, 5).join('; ') : `the arguments are ${args.map(kindOf).join(', ')}`
}

/** Replace each of `calls` on `target` with one whose type error names the wrong value, probed on `probeOf(name)`. */
const explainCalls = (
  target: Excelize | ExcelizeFile,
  calls: Map<string, WorkbookFunction>,
  probeOf: (name: string) => WorkbookFunction | undefined,
) =>
  Object.assign(
    target,
    Object.fromEntries(
      [...calls].map(([name, call]) => [
        name,
        (...args: WorkbookValue[]) => {
          const result = call(...args)
          const probe = typeFailure.safeParse(result).success ? probeOf(name) : undefined
          return probe ? { error: `${typeError}: ${describeTypeError(probe, args)}` } : result
        },
      ]),
    ),
  )

/**
 * Make every Excelize call that fails on an argument's type name the value and the kinds Excelize takes there, so a
 * script can fix its call: Excelize itself only says that some type is wrong. A workbook's calls are probed on a
 * blank workbook of their own, the pure helpers on themselves. Changes `excelize`, and each workbook it opens, in place.
 */
export const explainTypeErrors = (excelize: Excelize) => {
  const newFile = excelize.NewFile.bind(excelize)
  const openReader = excelize.OpenReader.bind(excelize)
  const helpers = functionsOf(excelize)
  helpers.delete('NewFile')
  helpers.delete('OpenReader')
  let blank: Map<string, WorkbookFunction> | undefined
  const onBlank = (name: string) => {
    blank ??= functionsOf(newFile())
    return blank.get(name)
  }
  const explainFile = (file: ExcelizeFile) => {
    explainCalls(file, functionsOf(file), onBlank)
    return file
  }
  explainCalls(excelize, helpers, (name) => helpers.get(name))
  return Object.assign(excelize, {
    NewFile: (...args: Parameters<Excelize['NewFile']>) => explainFile(newFile(...args)),
    OpenReader: (...args: Parameters<Excelize['OpenReader']>) => explainFile(openReader(...args)),
  })
}
