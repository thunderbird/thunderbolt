/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { updateReducer, initialUpdateState, type UpdateState } from './use-desktop-update'

describe('updateReducer', () => {
  describe('CHECK_START', () => {
    it('should set status to checking and clear error', () => {
      const stateWithError: UpdateState = {
        ...initialUpdateState,
        status: 'error',
        error: 'Previous error',
      }

      const result = updateReducer(stateWithError, { type: 'CHECK_START' })

      expect(result.status).toBe('checking')
      expect(result.error).toBeNull()
    })
  })

  describe('CHECK_SUCCESS', () => {
    it('should set status to available when update exists', () => {
      const mockUpdate = { version: '1.0.0' } as UpdateState['update']
      const state: UpdateState = { ...initialUpdateState, status: 'checking' }

      const result = updateReducer(state, { type: 'CHECK_SUCCESS', update: mockUpdate })

      expect(result.status).toBe('available')
      expect(result.update).toBe(mockUpdate)
    })

    it('should set status to idle when no update available', () => {
      const state: UpdateState = { ...initialUpdateState, status: 'checking' }

      const result = updateReducer(state, { type: 'CHECK_SUCCESS', update: null })

      expect(result.status).toBe('idle')
      expect(result.update).toBeNull()
    })
  })

  describe('DOWNLOAD_START', () => {
    it('should set status to downloading and reset progress', () => {
      const state: UpdateState = {
        ...initialUpdateState,
        status: 'available',
        downloadProgress: 50,
      }

      const result = updateReducer(state, { type: 'DOWNLOAD_START' })

      expect(result.status).toBe('downloading')
      expect(result.downloadProgress).toBe(0)
    })
  })

  describe('DOWNLOAD_PROGRESS', () => {
    it('should update download progress', () => {
      const state: UpdateState = { ...initialUpdateState, status: 'downloading' }

      const result = updateReducer(state, { type: 'DOWNLOAD_PROGRESS', progress: 75 })

      expect(result.downloadProgress).toBe(75)
      expect(result.status).toBe('downloading')
    })
  })

  describe('DOWNLOAD_SUCCESS', () => {
    it('should set status to ready and progress to 100', () => {
      const state: UpdateState = {
        ...initialUpdateState,
        status: 'downloading',
        downloadProgress: 99,
      }

      const result = updateReducer(state, { type: 'DOWNLOAD_SUCCESS' })

      expect(result.status).toBe('ready')
      expect(result.downloadProgress).toBe(100)
    })
  })

  describe('ERROR', () => {
    it('should set status to error with message', () => {
      const state: UpdateState = { ...initialUpdateState, status: 'downloading' }

      const result = updateReducer(state, { type: 'ERROR', error: 'Download failed' })

      expect(result.status).toBe('error')
      expect(result.error).toBe('Download failed')
    })

    it('should preserve other state when erroring', () => {
      const mockUpdate = { version: '1.0.0' } as UpdateState['update']
      const state: UpdateState = {
        ...initialUpdateState,
        status: 'downloading',
        update: mockUpdate,
        downloadProgress: 50,
      }

      const result = updateReducer(state, { type: 'ERROR', error: 'Network error' })

      expect(result.update).toBe(mockUpdate)
      expect(result.downloadProgress).toBe(50)
    })
  })

  describe('state transitions', () => {
    it('should handle full update flow', () => {
      const mockUpdate = { version: '2.0.0' } as UpdateState['update']

      let state = initialUpdateState
      expect(state.status).toBe('idle')

      state = updateReducer(state, { type: 'CHECK_START' })
      expect(state.status).toBe('checking')

      state = updateReducer(state, { type: 'CHECK_SUCCESS', update: mockUpdate })
      expect(state.status).toBe('available')

      state = updateReducer(state, { type: 'DOWNLOAD_START' })
      expect(state.status).toBe('downloading')
      expect(state.downloadProgress).toBe(0)

      state = updateReducer(state, { type: 'DOWNLOAD_PROGRESS', progress: 50 })
      expect(state.downloadProgress).toBe(50)

      state = updateReducer(state, { type: 'DOWNLOAD_SUCCESS' })
      expect(state.status).toBe('ready')
      expect(state.downloadProgress).toBe(100)
    })

    it('should handle error recovery flow', () => {
      let state = updateReducer(initialUpdateState, { type: 'CHECK_START' })
      state = updateReducer(state, { type: 'ERROR', error: 'Network error' })
      expect(state.status).toBe('error')

      state = updateReducer(state, { type: 'CHECK_START' })
      expect(state.status).toBe('checking')
      expect(state.error).toBeNull()
    })
  })
})
