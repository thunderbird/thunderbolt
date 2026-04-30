/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import { createCSSVars, useSafeAreaInset } from './use-safe-area-inset'
import { getClock } from '@/testing-library'

describe('createCSSVars', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty('--safe-area-top-padding')
    document.documentElement.style.removeProperty('--safe-area-bottom-padding')
  })

  it('sets CSS vars to pixel values when insets are positive', () => {
    createCSSVars({ top: 48, bottom: 24 })

    expect(document.documentElement.style.getPropertyValue('--safe-area-top-padding')).toBe('48px')
    expect(document.documentElement.style.getPropertyValue('--safe-area-bottom-padding')).toBe('24px')
  })

  it('falls back to env(safe-area-inset-*) when insets are zero', () => {
    createCSSVars({ top: 0, bottom: 0 })

    expect(document.documentElement.style.getPropertyValue('--safe-area-top-padding')).toBe(
      'env(safe-area-inset-top, 24px)',
    )
    expect(document.documentElement.style.getPropertyValue('--safe-area-bottom-padding')).toBe(
      'env(safe-area-inset-bottom, 24px)',
    )
  })

  it('falls back to env() when only top is zero', () => {
    createCSSVars({ top: 0, bottom: 16 })

    expect(document.documentElement.style.getPropertyValue('--safe-area-top-padding')).toBe(
      'env(safe-area-inset-top, 24px)',
    )
    expect(document.documentElement.style.getPropertyValue('--safe-area-bottom-padding')).toBe('16px')
  })

  it('falls back to env() when only bottom is zero', () => {
    createCSSVars({ top: 32, bottom: 0 })

    expect(document.documentElement.style.getPropertyValue('--safe-area-top-padding')).toBe('32px')
    expect(document.documentElement.style.getPropertyValue('--safe-area-bottom-padding')).toBe(
      'env(safe-area-inset-bottom, 24px)',
    )
  })

  it('falls back to env() when insets are negative', () => {
    createCSSVars({ top: -1, bottom: -5 })

    expect(document.documentElement.style.getPropertyValue('--safe-area-top-padding')).toBe(
      'env(safe-area-inset-top, 24px)',
    )
    expect(document.documentElement.style.getPropertyValue('--safe-area-bottom-padding')).toBe(
      'env(safe-area-inset-bottom, 24px)',
    )
  })
})

describe('useSafeAreaInset', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty('--safe-area-top-padding')
    document.documentElement.style.removeProperty('--safe-area-bottom-padding')
  })

  it('sets CSS var defaults synchronously before async insets resolve', () => {
    let resolve: (v: { adjustedInsetTop: number; adjustedInsetBottom: number }) => void
    const pending = new Promise<{ adjustedInsetTop: number; adjustedInsetBottom: number }>((r) => {
      resolve = r
    })

    renderHook(() =>
      useSafeAreaInset({
        isTauri: () => true,
        getInsets: () => pending,
      }),
    )

    // Before the promise resolves, CSS vars should already have defaults (not be empty)
    expect(document.documentElement.style.getPropertyValue('--safe-area-top-padding')).toBe(
      'env(safe-area-inset-top, 24px)',
    )
    expect(document.documentElement.style.getPropertyValue('--safe-area-bottom-padding')).toBe(
      'env(safe-area-inset-bottom, 24px)',
    )

    // Clean up the pending promise
    resolve!({ adjustedInsetTop: 0, adjustedInsetBottom: 0 })
  })

  it('sets CSS vars from insets when running in Tauri', async () => {
    renderHook(() =>
      useSafeAreaInset({
        isTauri: () => true,
        getInsets: () => Promise.resolve({ adjustedInsetTop: 44, adjustedInsetBottom: 20 }),
      }),
    )

    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(document.documentElement.style.getPropertyValue('--safe-area-top-padding')).toBe('44px')
    expect(document.documentElement.style.getPropertyValue('--safe-area-bottom-padding')).toBe('20px')
  })

  it('falls back to env() when getInsets returns null', async () => {
    renderHook(() =>
      useSafeAreaInset({
        isTauri: () => true,
        getInsets: () => Promise.resolve(null),
      }),
    )

    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(document.documentElement.style.getPropertyValue('--safe-area-top-padding')).toBe(
      'env(safe-area-inset-top, 24px)',
    )
    expect(document.documentElement.style.getPropertyValue('--safe-area-bottom-padding')).toBe(
      'env(safe-area-inset-bottom, 24px)',
    )
  })

  it('falls back to env() when getInsets rejects', async () => {
    renderHook(() =>
      useSafeAreaInset({
        isTauri: () => true,
        getInsets: () => Promise.reject(new Error('not android')),
      }),
    )

    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(document.documentElement.style.getPropertyValue('--safe-area-top-padding')).toBe(
      'env(safe-area-inset-top, 24px)',
    )
    expect(document.documentElement.style.getPropertyValue('--safe-area-bottom-padding')).toBe(
      'env(safe-area-inset-bottom, 24px)',
    )
  })

  it('sets CSS vars to env() fallback when not running in Tauri', async () => {
    renderHook(() =>
      useSafeAreaInset({
        isTauri: () => false,
        getInsets: () => Promise.reject(new Error('should not be called')),
      }),
    )

    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(document.documentElement.style.getPropertyValue('--safe-area-top-padding')).toBe(
      'env(safe-area-inset-top, 24px)',
    )
    expect(document.documentElement.style.getPropertyValue('--safe-area-bottom-padding')).toBe(
      'env(safe-area-inset-bottom, 24px)',
    )
  })
})
