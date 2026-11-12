/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// JSC lacks these standard globals; install them before importing libraries that capture them.
globalThis.self = globalThis;
globalThis.window = globalThis;
globalThis.performance ??= { now: () => Date.now(), timeOrigin: Date.now() };
globalThis.SharedArrayBuffer = ArrayBuffer;
Object.defineProperty(ArrayBuffer.prototype, 'resizable', { configurable: true, get: function () { return false; } });
Object.defineProperty(ArrayBuffer.prototype, 'growable', { configurable: true, get: function () { return false; } });
Object.defineProperty(ArrayBuffer.prototype, 'maxByteLength', { configurable: true, get: function () { return this.byteLength; } });

globalThis.TextEncoder = class {
  encode(value = '') {
    const encoded = unescape(encodeURIComponent(String(value)));
    const bytes = new Uint8Array(encoded.length);
    for (let index = 0; index < encoded.length; index += 1) bytes[index] = encoded.charCodeAt(index);
    return bytes;
  }
  encodeInto(value, destination) {
    const bytes = this.encode(value);
    const length = Math.min(bytes.length, destination.length);
    destination.set(bytes.subarray(0, length));
    return { read: value.length, written: length };
  }
};

globalThis.TextDecoder = class {
  constructor(_encoding = 'utf-8', options = {}) { this.pending = []; this.fatal = options.fatal === true; }
  decode(input, options = {}) {
    const incoming = input == null ? [] : Array.from(new Uint8Array(input));
    const bytes = this.pending.concat(incoming);
    this.pending = [];
    if (options.stream && bytes.length > 0) {
      let start = bytes.length - 1;
      while (start >= 0 && (bytes[start] & 0xC0) === 0x80) start -= 1;
      if (start >= 0) {
        const lead = bytes[start];
        const expected = lead < 0x80 ? 1 : lead >= 0xC2 && lead <= 0xDF ? 2 : lead >= 0xE0 && lead <= 0xEF ? 3 : lead >= 0xF0 && lead <= 0xF4 ? 4 : 1;
        if (expected > bytes.length - start) this.pending = bytes.splice(start);
      }
    }
    let output = '';
    for (let index = 0; index < bytes.length;) {
      const first = bytes[index];
      if (first < 0x80) { output += String.fromCharCode(first); index += 1; continue; }
      const count = first >= 0xC2 && first <= 0xDF ? 2 : first >= 0xE0 && first <= 0xEF ? 3 : first >= 0xF0 && first <= 0xF4 ? 4 : 0;
      let codePoint = count === 2 ? first & 0x1F : count === 3 ? first & 0x0F : first & 0x07;
      let valid = count > 0 && index + count <= bytes.length;
      for (let offset = 1; valid && offset < count; offset += 1) {
        const next = bytes[index + offset];
        if ((next & 0xC0) !== 0x80) valid = false;
        else codePoint = (codePoint << 6) | (next & 0x3F);
      }
      if (valid && ((count === 2 && codePoint < 0x80) || (count === 3 && codePoint < 0x800) ||
        (count === 4 && codePoint < 0x10000) || codePoint > 0x10FFFF || (codePoint >= 0xD800 && codePoint <= 0xDFFF))) valid = false;
      if (!valid) {
        if (this.fatal) throw new TypeError('Invalid UTF-8 sequence');
        output += '\uFFFD';
        index += 1;
      } else {
        output += String.fromCodePoint(codePoint);
        index += count;
      }
    }
    return output;
  }
};

const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const decodeBase64 = (value) => {
  const bytes = new Uint8Array(Math.floor(value.length * 3 / 4));
  let accumulator = 0;
  let bits = 0;
  let offset = 0;
  for (const character of value) {
    if (character === '=') break;
    const digit = base64Alphabet.indexOf(character);
    if (digit < 0) continue;
    accumulator = (accumulator << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset++] = (accumulator >> bits) & 0xFF;
    }
  }
  return bytes.subarray(0, offset);
};

if (typeof globalThis.__thunderboltNative !== 'undefined') {
  globalThis.crypto = {
    randomUUID: () => globalThis.__thunderboltNative.randomUUID(),
    getRandomValues: (target) => {
      const bytes = decodeBase64(globalThis.__thunderboltNative.randomBytes(target.byteLength));
      if (bytes.byteLength !== target.byteLength) throw new Error('Secure random bytes are unavailable');
      target.set(bytes);
      return target;
    }
  };
}
