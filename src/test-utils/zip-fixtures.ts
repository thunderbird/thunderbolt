/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { strToU8, zipSync } from 'fflate'

/** The signature that opens each central directory record. */
export const centralSignature = Buffer.from([0x50, 0x4b, 0x01, 0x02])

/** A zip whose central directory lists `count` stored entries that all point at one 1 MiB payload and declare 0 bytes. */
export const overlappingStoredEntries = (count: number) => {
  const zip = zipSync({ 'payload.bin': new Uint8Array(1024 * 1024) }, { level: 0 })
  const central = Buffer.from(zip).indexOf(centralSignature)
  const record = zip.slice(central, zip.length - 22)
  const records = Array.from({ length: count }, (_, index) => {
    const copy = record.slice()
    new DataView(copy.buffer).setUint32(24, 0, true)
    copy.set(strToU8(`file${String(index).padStart(3, '0')}.bin`), 46)
    return copy
  })
  const end = zip.slice(-22)
  const view = new DataView(end.buffer)
  view.setUint16(8, count, true)
  view.setUint16(10, count, true)
  view.setUint32(12, count * record.length, true)
  return new Uint8Array(Buffer.concat([zip.subarray(0, central), ...records, end]))
}

/** Moves the entry count into a ZIP64 end record, the only place a count over 65,535 fits. */
export const withZip64Count = (zip: Uint8Array<ArrayBuffer>, count: number) => {
  const end = zip.byteLength - 22
  const classic = new DataView(zip.buffer)
  // A ZIP64 end of central directory record (56 bytes), then its locator (20 bytes).
  const zip64 = new DataView(new ArrayBuffer(76))
  zip64.setUint32(0, 0x06064b50, true)
  zip64.setBigUint64(4, 44n, true)
  zip64.setUint16(12, 45, true)
  zip64.setUint16(14, 45, true)
  zip64.setBigUint64(24, BigInt(count), true)
  zip64.setBigUint64(32, BigInt(count), true)
  zip64.setBigUint64(40, BigInt(classic.getUint32(end + 12, true)), true)
  zip64.setBigUint64(48, BigInt(classic.getUint32(end + 16, true)), true)
  zip64.setUint32(56, 0x07064b50, true)
  zip64.setBigUint64(64, BigInt(end), true)
  zip64.setUint32(72, 1, true)
  const classicEnd = zip.slice(end)
  new DataView(classicEnd.buffer).setUint16(8, 0xffff, true)
  new DataView(classicEnd.buffer).setUint16(10, 0xffff, true)
  return new Uint8Array(Buffer.concat([zip.subarray(0, end), new Uint8Array(zip64.buffer), classicEnd]))
}
