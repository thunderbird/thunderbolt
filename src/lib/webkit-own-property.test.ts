/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { createContext, runInContext } from 'node:vm'
import { installWebKitOwnPropertyCompat } from './webkit-own-property'

const macWebKit = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)'

/** Evaluate each case in a fresh realm, leaving the test runner's built-ins untouched. */
const realm = (userAgent = macWebKit) => {
  const context = createContext({ userAgent })
  runInContext('const nativePrototype = Object.prototype.hasOwnProperty; const nativeStatic = Object.hasOwn;', context)
  runInContext(`'use strict'; (${installWebKitOwnPropertyCompat.toString()})(userAgent)`, context)
  return (source: string): unknown => runInContext(source, context)
}

describe('desktop WebKit own-property compatibility', () => {
  it('covers own, inherited, non-enumerable, undefined, symbol and accessor properties', () => {
    expect(
      realm()(`(() => {
      const symbol = Symbol('own');
      const object = Object.create({ inherited: true });
      Object.defineProperties(object, {
        plain: { value: 1, enumerable: true },
        empty: { value: undefined },
        hidden: { value: 2 },
        accessor: { get() { throw new Error('must not invoke a getter'); } },
      });
      object[symbol] = true;
      return ['plain', 'empty', 'hidden', 'accessor', symbol, 'inherited', 'missing'].map(key => [
        Object.prototype.hasOwnProperty.call(object, key), Object.hasOwn(object, key),
      ]);
    })()`),
    ).toEqual([
      [true, true],
      [true, true],
      [true, true],
      [true, true],
      [true, true],
      [false, false],
      [false, false],
    ])
  })

  it('matches the original methods for primitive receivers and unusual property keys', () => {
    expect(
      realm()(`(() => {
      const receivers = [null, undefined, 'abc', 42, false, 1n, Symbol('value'), [], Object.create(null)];
      const keys = ['length', 0, -0, null, undefined, true, 1n, Symbol.iterator, '__proto__'];
      const result = (method, receiver, key, prototype) => {
        try { return prototype ? method.call(receiver, key) : method(receiver, key); }
        catch (error) { return error.name; }
      };
      return receivers.every(receiver => keys.every(key =>
        result(nativePrototype, receiver, key, true) === result(Object.prototype.hasOwnProperty, receiver, key, true)
        && result(nativeStatic, receiver, key, false) === result(Object.hasOwn, receiver, key, false)));
    })()`),
    ).toBe(true)
  })

  it('coerces keys exactly once with the string hint, including boxed symbols', () => {
    expect(
      realm()(`(() => {
      const symbol = Symbol('key');
      const object = { [symbol]: true };
      const hints = [];
      const key = { [Symbol.toPrimitive](hint) { hints.push(hint); return symbol; } };
      return [Object.prototype.hasOwnProperty.call(object, key), Object.hasOwn(object, key),
        Object.prototype.hasOwnProperty.call(object, Object(symbol)), hints];
    })()`),
    ).toEqual([true, true, true, ['string', 'string']])
  })

  it('preserves the different receiver/key coercion orders and thrown values', () => {
    expect(
      realm()(`(() => {
      const sentinel = new Error('key coercion');
      const key = { [Symbol.toPrimitive]() { throw sentinel; } };
      const thrown = (run) => { try { run(); } catch (error) { return error === sentinel ? 'key' : error.name; } };
      const prototype = Object.prototype.hasOwnProperty;
      return [thrown(() => prototype.call(null, key)), thrown(() => Object.hasOwn(null, key)),
        thrown(() => prototype('key')), thrown(() => new prototype('key'))];
    })()`),
    ).toEqual(['key', 'TypeError', 'TypeError', 'TypeError'])
  })

  it('uses only the proxy own-descriptor trap and propagates revoked proxy errors', () => {
    expect(
      realm()(`(() => {
      const calls = [];
      const proxy = new Proxy({ present: true }, {
        getOwnPropertyDescriptor(target, key) { calls.push(key); return Reflect.getOwnPropertyDescriptor(target, key); },
        has() { throw new Error('must not use the has trap'); },
        get() { throw new Error('must not read the value'); },
      });
      const own = Object.prototype.hasOwnProperty.call(proxy, 'present');
      const missing = Object.hasOwn(proxy, 'missing');
      const revoked = Proxy.revocable({}, {}); revoked.revoke();
      try { Object.hasOwn(revoked.proxy, 'x'); } catch (error) { return [own, missing, calls, error.name]; }
    })()`),
    ).toEqual([true, false, ['present', 'missing'], 'TypeError'])
  })

  it('keeps built-in property attributes, function names, arities and non-constructability', () => {
    expect(
      realm()(`(() => {
      const prototype = Object.getOwnPropertyDescriptor(Object.prototype, 'hasOwnProperty');
      const own = Object.getOwnPropertyDescriptor(Object, 'hasOwn');
      return [prototype.enumerable, prototype.configurable, prototype.writable,
        own.enumerable, own.configurable, own.writable,
        prototype.value.name, prototype.value.length, own.value.name, own.value.length,
        Object.getOwnPropertyDescriptor(prototype.value, 'prototype'),
        Object.getOwnPropertyDescriptor(own.value, 'prototype')];
    })()`),
    ).toEqual([false, true, true, false, true, true, 'hasOwnProperty', 1, 'hasOwn', 2, undefined, undefined])
  })

  it('does not replace methods again when another chunk installs the same compatibility code', () => {
    const evaluate = realm()
    evaluate('const firstPrototype = Object.prototype.hasOwnProperty; const firstStatic = Object.hasOwn;')
    evaluate(`'use strict'; (${installWebKitOwnPropertyCompat.toString()})(userAgent)`)
    expect(evaluate('firstPrototype === Object.prototype.hasOwnProperty && firstStatic === Object.hasOwn')).toBe(true)
  })

  for (const userAgent of [
    '',
    `${macWebKit} Chrome/130.0.0.0 Safari/537.36`,
    `${macWebKit} Edg/130.0.0.0`,
    'Mozilla/5.0 (Macintosh) Gecko/20100101 Firefox/130.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15',
    'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15',
  ]) {
    it(`leaves other engines/platforms untouched: ${userAgent || 'no navigator'}`, () => {
      expect(
        realm(userAgent)('nativePrototype === Object.prototype.hasOwnProperty && nativeStatic === Object.hasOwn'),
      ).toBe(true)
    })
  }
})
