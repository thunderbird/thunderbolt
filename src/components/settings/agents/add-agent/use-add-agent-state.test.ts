/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { getClock } from '@/testing-library'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { useAddAgentState } from './use-add-agent-state'
import type { AgentSetupInput, AgentSetupSuggestion } from './agent-setup-suggestion'
import type { AgentResource } from './types'

const resources: AgentResource[] = [
  { id: 'default', kind: 'model', scope: 'personal', name: 'Default model', description: '', defaultSelected: true },
  { id: 'team', kind: 'model', scope: 'organization', name: 'Team model', description: '' },
  { id: 'github', kind: 'mcp', scope: 'personal', name: 'GitHub', description: 'Code and issues' },
  { id: 'research', kind: 'skill', scope: 'personal', name: 'Research', description: 'Find answers' },
]
const suggestion: AgentSetupSuggestion = {
  name: 'Research buddy',
  systemPrompt: 'Cite sources.',
  environment: 'desktop',
  models: ['Team model'],
  connections: ['GitHub'],
  skills: ['Research'],
}
const begin = (controller: ReturnType<typeof renderHook<ReturnType<typeof useAddAgentState>, unknown>>['result']) => {
  act(() => controller.current.next())
  act(() => controller.current.edit({ description: 'Find credible answers' }))
}

describe('agent setup suggestions', () => {
  afterEach(cleanup)

  it('suggests a name, keeps the purpose, and reuses the blur request on Continue', async () => {
    const pending = Promise.withResolvers<AgentSetupSuggestion>()
    const suggest = mock((_input: AgentSetupInput, _signal: AbortSignal) => pending.promise)
    const { result } = renderHook(() => useAddAgentState(resources, true, suggest))
    begin(result)
    expect(result.current.canContinueBasics).toBe(true)
    expect(result.current.draft.name).toBe('')
    act(() => {
      void result.current.suggest()
    })
    act(() => result.current.next())
    expect(suggest).toHaveBeenCalledTimes(1)
    expect(result.current.step).toBe('configure')
    await act(async () => pending.resolve(suggestion))
    expect(result.current.draft.name).toBe('Research buddy')
    expect(result.current.draft.description).toBe('Find credible answers')
    expect(result.current.draft.environment).toBe('desktop')
    expect(result.current.draft.access).toBe('approval')
    expect(result.current.selectedResources.map(({ id }) => id)).toEqual(['team', 'github', 'research'])
    act(() => result.current.back())
    act(() => result.current.next())
    expect(suggest).toHaveBeenCalledTimes(1)
  })

  it('preserves manual name, environment, prompt, and toggles made during generation', async () => {
    const pending = Promise.withResolvers<AgentSetupSuggestion>()
    const suggest = mock((_input: AgentSetupInput, _signal: AbortSignal) => pending.promise)
    const { result } = renderHook(() => useAddAgentState(resources, true, suggest))
    begin(result)
    act(() => result.current.edit({ description: 'My description', environment: 'sandbox' }))
    act(() => result.current.next())
    act(() => result.current.edit({ name: 'Joe', systemPrompt: 'My prompt' }))
    expect(suggest.mock.calls[0][1].aborted).toBe(false)
    act(() => result.current.toggle('github', false))
    act(() => result.current.toggle('default', true))
    await act(async () => pending.resolve(suggestion))
    expect(result.current.draft).toMatchObject({
      name: 'Joe',
      description: 'My description',
      environment: 'sandbox',
      systemPrompt: 'My prompt',
    })
    expect(result.current.selectedResources.map(({ id }) => id)).toEqual(['default', 'team', 'research'])
    expect(suggest.mock.calls[0][0].description).toBe('My description')
  })

  it('aborts obsolete requests and ignores late results after the purpose changes', async () => {
    const first = Promise.withResolvers<AgentSetupSuggestion>()
    const second = Promise.withResolvers<AgentSetupSuggestion>()
    const suggest = mock((_input: AgentSetupInput, _signal: AbortSignal) => first.promise)
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const { result } = renderHook(() => useAddAgentState(resources, false, suggest))
    begin(result)
    act(() => {
      void result.current.suggest()
    })
    act(() => result.current.edit({ description: 'Write clearly' }))
    expect(suggest.mock.calls[0][1].aborted).toBe(true)
    act(() => result.current.next())
    await act(async () => second.resolve({ ...suggestion, name: 'Writing buddy', systemPrompt: 'Write clearly.' }))
    await act(async () => first.resolve(suggestion))
    expect(result.current.draft.description).toBe('Write clearly')
    expect(result.current.draft.name).toBe('Writing buddy')
    expect(result.current.draft.systemPrompt).toBe('Write clearly.')
    expect(result.current.draft.environment).toBe('sandbox')
  })

  it('allows manual configuration after failure and retries explicitly', async () => {
    const suggest = mock(async () => suggestion).mockRejectedValueOnce(new Error('Unavailable'))
    const { result } = renderHook(() => useAddAgentState(resources, false, suggest))
    begin(result)
    await act(async () => result.current.next())
    expect(result.current.suggestionStatus).toBe('error')
    expect(result.current.showName).toBe(true)
    expect(result.current.canPreview).toBe(false)
    act(() => result.current.edit({ name: 'My agent' }))
    expect(result.current.canPreview).toBe(true)
    await act(async () => result.current.suggest(true))
    expect(result.current.suggestionStatus).toBe('ready')
    expect(result.current.draft.name).toBe('My agent')
  })

  it('refreshes generated names for a new purpose but keeps a name the user chose', async () => {
    const suggest = mock(async (_input: AgentSetupInput, _signal: AbortSignal) => suggestion)
    const { result } = renderHook(() => useAddAgentState(resources, false, suggest))
    begin(result)
    await act(async () => result.current.suggest())
    act(() => result.current.edit({ description: 'Review code' }))
    expect(result.current.draft.name).toBe('')
    act(() => result.current.edit({ name: 'Joe' }))
    act(() => result.current.edit({ description: 'Help me write' }))
    await act(async () => result.current.suggest())
    expect(result.current.draft.name).toBe('Joe')
    expect(suggest.mock.calls[1][0].description).toBe('Help me write')
  })

  it('ignores an empty purpose and uses the selected starter immediately', async () => {
    const suggest = mock(async (_input: AgentSetupInput, _signal: AbortSignal) => suggestion)
    const { result } = renderHook(() => useAddAgentState(resources, false, suggest))
    act(() => result.current.next())
    act(() => result.current.edit({ description: '   ' }))
    await act(async () => result.current.suggest())
    expect(result.current.canContinueBasics).toBe(false)
    expect(suggest).not.toHaveBeenCalled()
    await act(async () => result.current.selectStarter('Research a topic'))
    expect(suggest.mock.calls[0][0].description).toBe('Research a topic')
    expect(result.current.draft.description).toBe('Research a topic')
    expect(result.current.draft.name).toBe('Research buddy')
  })

  it('times out a stalled request and cancels requests on unmount', async () => {
    const pending = Promise.withResolvers<AgentSetupSuggestion>()
    const suggest = mock((_input: AgentSetupInput, _signal: AbortSignal) => pending.promise)
    const { result, unmount } = renderHook(() => useAddAgentState(resources, false, suggest))
    begin(result)
    act(() => result.current.next())
    await act(async () => getClock().tickAsync(30_000))
    expect(suggest.mock.calls[0][1].aborted).toBe(true)
    expect(result.current.suggestionStatus).toBe('error')
    act(() => {
      void result.current.suggest(true)
    })
    unmount()
    expect(suggest.mock.calls[1][1].aborted).toBe(true)
    pending.resolve(suggestion)
  })
})
