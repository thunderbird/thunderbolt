/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import { createBrowserController } from './browser-controller'

const setup = () => {
  const controller = createBrowserController()
  const unregister = controller.registerPanel({ listTabs: () => [{ id: 'one' }, { id: 'two' }] })
  return { controller, unregister }
}

describe('page activity lifetime', () => {
  it('retains activity between tools and publishes only changes', () => {
    const { controller } = setup()
    const changed = mock(() => undefined)
    const unsubscribe = controller.subscribe(changed)
    const finish = controller.startAgentTurn('turn')
    const agent = controller.forAgentTurn('turn')
    const signal = agent.claimPage('one')
    agent.claimPage('one')
    expect(controller.getState()).toEqual({ paused: false, busyTabId: 'one' })
    expect(changed).toHaveBeenCalledTimes(1)
    agent.claimPage('two')
    expect(changed).toHaveBeenCalledTimes(2)
    finish()
    expect(signal.aborted).toBe(true)
    expect(controller.getState().busyTabId).toBeNull()
    expect(() => agent.claimPage('one')).toThrow('finished')
    unsubscribe()
    controller.stop()
    expect(changed).toHaveBeenCalledTimes(3)
  })

  it('keeps concurrent turns independent and restores the remaining active turn', () => {
    const { controller } = setup()
    const firstDone = controller.startAgentTurn('first')
    const secondDone = controller.startAgentTurn('second')
    const first = controller.forAgentTurn('first').claimPage('one')
    controller.forAgentTurn('second').claimPage('two')
    expect(controller.getState().busyTabId).toBe('two')
    secondDone()
    expect(controller.getState().busyTabId).toBe('one')
    expect(first.aborted).toBe(false)
    secondDone()
    expect(first.aborted).toBe(false)
    firstDone()
    expect(controller.getState().busyTabId).toBeNull()
  })

  it('revokes replaced turns without letting stale cleanup finish the replacement', () => {
    const { controller } = setup()
    const oldDone = controller.startAgentTurn('same')
    const old = controller.forAgentTurn('same')
    const signal = old.claimPage('one')
    controller.startAgentTurn('same')
    expect(signal.aborted).toBe(true)
    expect(() => old.claimPage('one')).toThrow('replaced')
    const replacement = controller.forAgentTurn('same')
    replacement.claimPage('two')
    oldDone()
    expect(controller.getState().busyTabId).toBe('two')
    expect(replacement.claimPage('two').aborted).toBe(false)
  })

  it('revokes all claimed signals on Stop; resume only permits new operations', () => {
    const { controller } = setup()
    controller.startAgentTurn('turn')
    const agent = controller.forAgentTurn('turn')
    const first = agent.claimPage('one')
    const unscoped = controller.claimPage('two')
    controller.resume() // An idempotent resume must not detach pending operations from Stop.
    controller.stop()
    expect(first.aborted).toBe(true)
    expect(unscoped.aborted).toBe(true)
    expect(controller.getState()).toEqual({ paused: true, busyTabId: null })
    expect(() => agent.assertControl()).toThrow('stopped')
    expect(() => controller.claimPage('one')).toThrow('stopped')
    controller.resume()
    expect(first.aborted).toBe(true)
    expect(agent.claimPage('one').aborted).toBe(false)
  })

  it('honors caller cancellation and refuses unknown pages or finished turns', () => {
    const { controller } = setup()
    const abort = new AbortController()
    const signal = controller.claimPage('one', abort.signal)
    abort.abort(new Error('Canceled'))
    expect(signal.aborted).toBe(true)
    expect(() => controller.assertControl(abort.signal)).toThrow('Canceled')
    expect(() => controller.claimPage('missing')).toThrow('no longer exists')
    expect(() => controller.forAgentTurn('missing').claimPage('one')).toThrow('finished')
  })

  it('releases closed-page activity across all turns without aborting another page', () => {
    const { controller } = setup()
    controller.startAgentTurn('first')
    controller.startAgentTurn('second')
    const first = controller.forAgentTurn('first').claimPage('one')
    const second = controller.forAgentTurn('second').claimPage('two')
    controller.releasePage('two')
    expect(controller.getState().busyTabId).toBe('one')
    expect(second.aborted).toBe(false)
    controller.releasePage('one')
    expect(controller.getState().busyTabId).toBeNull()
    expect(first.aborted).toBe(false)
  })

  it('revokes pending and late operations on panel teardown and ignores stale cleanup', () => {
    const { controller, unregister } = setup()
    controller.startAgentTurn('turn')
    const agent = controller.forAgentTurn('turn')
    const signal = agent.claimPage('one')
    const latestCleanup = controller.registerPanel({ listTabs: () => [{ id: 'two' }] })
    unregister()
    expect(signal.aborted).toBe(false)
    agent.claimPage('two')
    latestCleanup()
    expect(signal.aborted).toBe(true)
    expect(() => agent.claimPage('two')).toThrow('closed')
    expect(controller.getState().busyTabId).toBeNull()
    controller.registerPanel({ listTabs: () => [{ id: 'new' }] })
    expect(controller.claimPage('new').aborted).toBe(false)
  })

  it('preserves Stop across panel remounts', () => {
    const { controller, unregister } = setup()
    controller.stop()
    unregister()
    controller.registerPanel({ listTabs: () => [{ id: 'new' }] })
    expect(() => controller.claimPage('new')).toThrow('stopped')
    controller.resume()
    expect(controller.claimPage('new').aborted).toBe(false)
  })
})
