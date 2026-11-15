/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Inflate, strFromU8 } from 'fflate'

/** Thrown for a zip whose parts would unpack past a limit: too many parts, or too many bytes. */
export class ZipLimitError extends Error {
  constructor(readonly limit: 'parts' | 'bytes') {
    super(`The zip is over its ${limit} limit`)
  }
}

export type UnzipLimits = {
  /** What the kept parts may add up to, each at the larger of its packed and declared sizes. */
  bytes: number
  /** How many parts the zip may list, kept or not. */
  parts: number
}

/** Compressed input handed to the inflater at a time, which bounds the work done past a limit before it is noticed. */
const inflateChunkBytes = 16 * 1024

const signatures = { end: 0x06054b50, central: 0x02014b50, local: 0x04034b50 }

/** What a ZIP64 zip writes in place of a size, offset or count. Office files are far too small to need one. */
const zip64Marker = 0xffffffff

/** The end of central directory record, which sits in the last 64 KiB of the zip, after an optional comment. */
const findEnd = (view: DataView) => {
  for (let at = view.byteLength - 22; at >= Math.max(0, view.byteLength - 22 - 0xffff); at--) {
    if (view.getUint32(at, true) === signatures.end) {
      return at
    }
  }
  throw new Error('The file is not a zip')
}

/**
 * Inflates one part into a buffer of the size it declares, which the caller has already counted. It stops once the
 * buffer is full, so input past that point, such as junk after the last block, costs nothing.
 */
const inflatePart = (compressed: Uint8Array, declared: number) => {
  const part = new Uint8Array(declared)
  const state = { produced: 0 }
  const inflater = new Inflate((chunk) => {
    if (state.produced + chunk.length > declared) {
      throw new Error('A part of the zip unpacks to more than it declares')
    }
    part.set(chunk, state.produced)
    state.produced += chunk.length
  })
  for (let at = 0; state.produced < declared && at < compressed.length; at += inflateChunkBytes) {
    inflater.push(compressed.subarray(at, at + inflateChunkBytes), at + inflateChunkBytes >= compressed.length)
  }
  if (state.produced !== declared) {
    throw new Error('A part of the zip unpacks to less than it declares')
  }
  return part
}

/** Reads the parts; a record pointing past the end of the file throws a RangeError from the DataView. */
const readParts = (zip: Uint8Array, limits: UnzipLimits, keep: (name: string) => boolean) => {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  const end = findEnd(view)
  const count = view.getUint16(end + 10, true)
  // A count of 0xffff means the real one is in a ZIP64 record, and is larger.
  if (count >= 0xffff || count > limits.parts) {
    throw new ZipLimitError('parts')
  }
  let at = view.getUint32(end + 16, true)
  if (at === zip64Marker) {
    throw new Error('The zip has an encrypted or ZIP64 part')
  }
  const total = { bytes: 0 }
  const parts = new Map<string, Uint8Array>()
  for (let index = 0; index < count; index++) {
    if (view.getUint32(at, true) !== signatures.central) {
      throw new Error('The zip directory is damaged')
    }
    const flags = view.getUint16(at + 8, true)
    const method = view.getUint16(at + 10, true)
    const packed = view.getUint32(at + 20, true)
    const size = view.getUint32(at + 24, true)
    const nameLength = view.getUint16(at + 28, true)
    const local = view.getUint32(at + 42, true)
    // Read as UTF-8 whether or not the zip says so, as JSZip, the renderers' reader, reads it. Tools that zip a
    // folder, such as macOS Finder, write UTF-8 names without the flag.
    const name = strFromU8(zip.subarray(at + 46, at + 46 + nameLength))
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true)
    if (!keep(name)) {
      continue
    }
    if (flags & 1 || [packed, size, local].includes(zip64Marker)) {
      throw new Error('The zip has an encrypted or ZIP64 part')
    }
    // Each part counts at the larger of what is read and what it declares, which also bounds what it inflates to.
    // Counting only the output would let many records that point at one part of empty blocks cost minutes.
    total.bytes += Math.max(packed, size)
    if (total.bytes > limits.bytes) {
      throw new ZipLimitError('bytes')
    }
    if (view.getUint32(local, true) !== signatures.local) {
      throw new Error('The zip directory points at no part')
    }
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    const compressed = zip.subarray(start, start + packed)
    if (compressed.length !== packed) {
      throw new Error('A part of the zip runs past its end')
    }
    if (method === 0) {
      parts.set(name, compressed.slice())
    } else if (method === 8) {
      parts.set(name, size === 0 ? new Uint8Array() : inflatePart(compressed, size))
    } else {
      throw new Error(`The zip uses compression method ${method}`)
    }
  }
  return parts
}

/**
 * The parts `keep` selects, by name, read through the zip's central directory as unzip tools and JSZip read it.
 * `fflate.unzipSync` sizes a part's buffer by what the zip declares, then inflates the whole part and drops what does
 * not fit, so a file can declare tiny parts and inflate a thousand times its size, at about twelve seconds of the
 * main thread per GiB under Bun. This stops each part at its declared size and the zip at its limits. Encrypted and ZIP64
 * parts, and a damaged zip, throw an Error that says so.
 */
export const unzipWithinLimits = (
  zip: Uint8Array,
  limits: UnzipLimits,
  keep: (name: string) => boolean = () => true,
): Map<string, Uint8Array> => {
  try {
    return readParts(zip, limits, keep)
  } catch (error) {
    throw error instanceof RangeError
      ? new Error('The zip is damaged: a record points past the end of the file')
      : error
  }
}
