import { describe, expect, it } from 'bun:test'
import { createHaystackProvider } from './haystack-provider'
import type { HaystackPipelineConfig } from '@/haystack/types'

describe('createHaystackProvider', () => {
  const wsBaseUrl = 'ws://localhost:8000/v1'

  it('should return empty array when no pipelines configured', () => {
    const provider = createHaystackProvider([], wsBaseUrl)
    expect(provider.getAgents()).toEqual([])
  })

  it('should map a pipeline to a remote agent descriptor', () => {
    const pipelines: HaystackPipelineConfig[] = [
      { slug: 'eng-docs', name: 'Engineering Docs', pipelineName: 'eng-v1', pipelineId: 'p1', icon: 'file-text' },
    ]

    const provider = createHaystackProvider(pipelines, wsBaseUrl)
    const agents = provider.getAgents()

    expect(agents).toHaveLength(1)
    expect(agents[0]).toEqual({
      id: 'agent-haystack-eng-docs',
      name: 'Engineering Docs',
      type: 'remote',
      transport: 'websocket',
      url: 'ws://localhost:8000/v1/haystack/ws/eng-docs',
      icon: 'file-text',
      isSystem: 1,
      enabled: 1,
    })
  })

  it('should use default icon when pipeline has no icon', () => {
    const pipelines: HaystackPipelineConfig[] = [
      { slug: 'docs', name: 'Docs', pipelineName: 'docs-v1', pipelineId: 'p1' },
    ]

    const provider = createHaystackProvider(pipelines, wsBaseUrl)
    const agents = provider.getAgents()

    expect(agents[0].icon).toBe('file-search')
  })

  it('should map multiple pipelines', () => {
    const pipelines: HaystackPipelineConfig[] = [
      { slug: 'eng', name: 'Engineering', pipelineName: 'eng-v1', pipelineId: 'p1' },
      { slug: 'legal', name: 'Legal', pipelineName: 'legal-v1', pipelineId: 'p2', icon: 'scale' },
    ]

    const provider = createHaystackProvider(pipelines, wsBaseUrl)
    const agents = provider.getAgents()

    expect(agents).toHaveLength(2)
    expect(agents[0].id).toBe('agent-haystack-eng')
    expect(agents[1].id).toBe('agent-haystack-legal')
    expect(agents[1].icon).toBe('scale')
  })
})
