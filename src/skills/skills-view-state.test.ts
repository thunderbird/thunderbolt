/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { defaultSkillDailyBrief, defaultSkillWeather } from '@/defaults/skills'
import type { Skill } from '@/types'
import {
  initialSkillsViewState,
  skillsViewReducer,
  type SkillsViewAction,
  type SkillsViewState,
} from './skills-view-state'

const skill = (id: string, name: string): Skill => ({
  id,
  name,
  label: null,
  description: 'd',
  instruction: 'i',
  enabled: 1,
  pinnedOrder: null,
  deletedAt: null,
  defaultHash: null,
  userId: null,
})

/** Apply a sequence of actions to the initial state. Useful for "in mode X, when Y, expect Z" tests. */
const run = (actions: SkillsViewAction[], from: SkillsViewState = initialSkillsViewState): SkillsViewState =>
  actions.reduce(skillsViewReducer, from)

describe('skillsViewReducer', () => {
  describe('SELECT_SKILL', () => {
    it('sets active and slides the panel in on mobile', () => {
      const next = skillsViewReducer(initialSkillsViewState, { type: 'SELECT_SKILL', id: 'a' })
      expect(next.activeId).toBe('a')
      expect(next.panelView).toBe('panel')
    })
  })

  describe('START_CREATE / START_EDIT', () => {
    it('enters create mode and clears any prior slug error', () => {
      const next = run([{ type: 'SLUG_REJECTED', message: 'old' }, { type: 'START_CREATE' }])
      expect(next.mode).toBe('create')
      expect(next.slugError).toBeNull()
      expect(next.panelView).toBe('panel')
    })

    it('enters edit mode for a specific id', () => {
      const next = skillsViewReducer(initialSkillsViewState, { type: 'START_EDIT', id: 'b' })
      expect(next.mode).toBe('edit')
      expect(next.activeId).toBe('b')
    })

    it('keeps widget skills read-only when an edit route selects them', () => {
      const widget = skillsViewReducer(initialSkillsViewState, {
        type: 'START_EDIT',
        id: defaultSkillWeather.id,
      })
      const task = skillsViewReducer(initialSkillsViewState, {
        type: 'START_EDIT',
        id: defaultSkillDailyBrief.id,
      })

      expect(widget.mode).toBe('detail')
      expect(widget.activeId).toBe(defaultSkillWeather.id)
      expect(task.mode).toBe('edit')
    })

    it('START_CREATE bumps resetSignal so the form re-mounts on back-to-back opens', () => {
      const next = skillsViewReducer({ ...initialSkillsViewState, resetSignal: 4 }, { type: 'START_CREATE' })
      expect(next.resetSignal).toBe(5)
    })
  })

  describe('REQUEST_LEAVE / CANCEL_DISCARD', () => {
    it('parks the intent for the discard dialog', () => {
      const next = skillsViewReducer(initialSkillsViewState, {
        type: 'REQUEST_LEAVE',
        leave: { type: 'cancel' },
      })
      expect(next.pendingLeave).toEqual({ type: 'cancel' })
    })

    it('CANCEL_DISCARD clears the parked intent', () => {
      const dirty: SkillsViewState = { ...initialSkillsViewState, pendingLeave: { type: 'cancel' } }
      const next = skillsViewReducer(dirty, { type: 'CANCEL_DISCARD' })
      expect(next.pendingLeave).toBeNull()
    })
  })

  describe('PERFORM_LEAVE', () => {
    it('returns to detail mode and bumps resetSignal so the form re-mounts', () => {
      const editing: SkillsViewState = {
        ...initialSkillsViewState,
        mode: 'edit',
        activeId: 'a',
        isDirty: true,
        slugError: 'stale',
        resetSignal: 3,
      }
      const next = skillsViewReducer(editing, {
        type: 'PERFORM_LEAVE',
        leave: { type: 'cancel' },
      })
      expect(next.mode).toBe('detail')
      expect(next.isDirty).toBe(false)
      expect(next.slugError).toBeNull()
      expect(next.resetSignal).toBe(4)
      expect(next.pendingLeave).toBeNull()
    })

    it('on desktop cancel, keeps the panel open (it shows the detail view)', () => {
      const editing: SkillsViewState = {
        ...initialSkillsViewState,
        mode: 'edit',
        activeId: 'a',
        panelView: 'panel',
      }
      const next = skillsViewReducer(editing, {
        type: 'PERFORM_LEAVE',
        leave: { type: 'cancel' },
      })
      expect(next.panelView).toBe('panel')
    })

    it('an edit intent lands in a fresh edit form on the target skill', () => {
      const creating: SkillsViewState = {
        ...initialSkillsViewState,
        mode: 'create',
        isDirty: true,
        panelView: 'list',
        resetSignal: 1,
      }
      const next = skillsViewReducer(creating, {
        type: 'PERFORM_LEAVE',
        leave: { type: 'edit', id: 'b' },
      })
      expect(next.mode).toBe('edit')
      expect(next.activeId).toBe('b')
      expect(next.panelView).toBe('panel')
      expect(next.isDirty).toBe(false)
      expect(next.resetSignal).toBe(2)
    })

    it('an edit intent lands on read-only detail for a widget skill', () => {
      const next = skillsViewReducer(initialSkillsViewState, {
        type: 'PERFORM_LEAVE',
        leave: { type: 'edit', id: defaultSkillWeather.id },
      })

      expect(next.mode).toBe('detail')
      expect(next.activeId).toBe(defaultSkillWeather.id)
      expect(next.panelView).toBe('panel')
    })

    it('a create intent lands in a blank create form', () => {
      const editing: SkillsViewState = {
        ...initialSkillsViewState,
        mode: 'edit',
        activeId: 'a',
        isDirty: true,
        panelView: 'panel',
      }
      const next = skillsViewReducer(editing, {
        type: 'PERFORM_LEAVE',
        leave: { type: 'create' },
      })
      expect(next.mode).toBe('create')
      // The prior edit target stays active — SUBMIT_SUCCESS overwrites it.
      expect(next.activeId).toBe('a')
      expect(next.panelView).toBe('panel')
    })

    it('on mobile cancel, keeps the panel open to show the detail view', () => {
      const editing: SkillsViewState = {
        ...initialSkillsViewState,
        mode: 'edit',
        activeId: 'a',
        panelView: 'panel',
      }
      const next = skillsViewReducer(editing, {
        type: 'PERFORM_LEAVE',
        leave: { type: 'cancel' },
      })
      expect(next.panelView).toBe('panel')
    })

    it('on mobile select, stays on the panel (the user is jumping skills, not leaving)', () => {
      const editing: SkillsViewState = {
        ...initialSkillsViewState,
        mode: 'edit',
        activeId: 'a',
        panelView: 'panel',
      }
      const next = skillsViewReducer(editing, {
        type: 'PERFORM_LEAVE',
        leave: { type: 'select', id: 'b' },
      })
      expect(next.activeId).toBe('b')
      expect(next.panelView).toBe('panel')
    })
  })

  describe('OPEN_DELETE / CLOSE_DELETE', () => {
    it('snapshots the skill so concurrent syncs cannot redirect the action', () => {
      const target = skill('a', 'foo')
      const next = skillsViewReducer(initialSkillsViewState, { type: 'OPEN_DELETE', skill: target })
      expect(next.pendingDelete).toBe(target)
      expect(next.activeId).toBe('a')
    })

    it('CLOSE_DELETE drops the snapshot', () => {
      const open: SkillsViewState = { ...initialSkillsViewState, pendingDelete: skill('a', 'foo') }
      const next = skillsViewReducer(open, { type: 'CLOSE_DELETE' })
      expect(next.pendingDelete).toBeNull()
    })
  })

  describe('OPEN_DEPENDENTS', () => {
    it('OPEN_DEPENDENTS snapshots the action target and dependents list', () => {
      const target = skill('a', 'foo')
      const dep = skill('b', 'bar')
      const next = skillsViewReducer(initialSkillsViewState, {
        type: 'OPEN_DEPENDENTS',
        payload: { action: 'disable', skill: target, dependents: [dep] },
      })
      expect(next.pendingDependents?.action).toBe('disable')
      expect(next.pendingDependents?.skill).toBe(target)
      expect(next.pendingDependents?.dependents).toEqual([dep])
      expect(next.activeId).toBe('a')
    })
  })

  describe('DIRTY_CHANGED / SUBMIT_SUCCESS', () => {
    it('DIRTY_CHANGED updates the form dirty flag', () => {
      const next = skillsViewReducer(initialSkillsViewState, { type: 'DIRTY_CHANGED', dirty: true })
      expect(next.isDirty).toBe(true)
    })

    it('SUBMIT_SUCCESS leaves edit mode and clears errors', () => {
      const editing: SkillsViewState = {
        ...initialSkillsViewState,
        mode: 'edit',
        activeId: 'a',
        isDirty: true,
        slugError: 'taken',
        resetSignal: 1,
      }
      const next = skillsViewReducer(editing, { type: 'SUBMIT_SUCCESS', activeId: 'new-id' })
      expect(next.mode).toBe('detail')
      expect(next.activeId).toBe('new-id')
      expect(next.isDirty).toBe(false)
      expect(next.slugError).toBeNull()
      expect(next.resetSignal).toBe(2)
    })
  })

  describe('error states', () => {
    it('SLUG_REJECTED stores the message', () => {
      const next = skillsViewReducer(initialSkillsViewState, { type: 'SLUG_REJECTED', message: 'bad name' })
      expect(next.slugError).toBe('bad name')
    })

    it('SLUG_REJECTED replaces a stale generic submit error', () => {
      const failed = skillsViewReducer(initialSkillsViewState, { type: 'SUBMIT_FAILED', message: 'save failed' })
      const next = skillsViewReducer(failed, { type: 'SLUG_REJECTED', message: 'taken' })
      expect(next.slugError).toBe('taken')
      expect(next.submitError).toBeNull()
    })

    it('SUBMIT_FAILED stores the generic message and keeps the form state intact', () => {
      const editing: SkillsViewState = { ...initialSkillsViewState, mode: 'edit', activeId: 'a', isDirty: true }
      const next = skillsViewReducer(editing, { type: 'SUBMIT_FAILED', message: 'save failed' })
      expect(next.submitError).toBe('save failed')
      expect(next.mode).toBe('edit')
      expect(next.isDirty).toBe(true)
    })

    it('SUBMIT_SUCCESS and PERFORM_LEAVE clear a stale submit error', () => {
      const failed = skillsViewReducer(initialSkillsViewState, { type: 'SUBMIT_FAILED', message: 'save failed' })
      expect(skillsViewReducer(failed, { type: 'SUBMIT_SUCCESS', activeId: 'a' }).submitError).toBeNull()
      expect(skillsViewReducer(failed, { type: 'PERFORM_LEAVE', leave: { type: 'cancel' } }).submitError).toBeNull()
    })

    it('CLEAR_SLUG_ERROR drops a stale slug error', () => {
      const withName = skillsViewReducer(initialSkillsViewState, { type: 'SLUG_REJECTED', message: 'taken' })
      const cleared = skillsViewReducer(withName, { type: 'CLEAR_SLUG_ERROR' })
      expect(cleared.slugError).toBeNull()
    })

    it('CLEAR_SLUG_ERROR is a no-op (same reference) when there is no error', () => {
      const next = skillsViewReducer(initialSkillsViewState, { type: 'CLEAR_SLUG_ERROR' })
      // Reference equality keeps unrelated subscribers from re-rendering on
      // every keystroke once the error is already gone.
      expect(next).toBe(initialSkillsViewState)
    })
  })

  describe('BACK_TO_LIST', () => {
    it('slides the panel back to the list on mobile', () => {
      const panel: SkillsViewState = { ...initialSkillsViewState, panelView: 'panel' }
      const next = skillsViewReducer(panel, { type: 'BACK_TO_LIST' })
      expect(next.panelView).toBe('list')
    })
  })
})
