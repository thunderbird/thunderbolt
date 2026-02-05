import { SourceList } from '@/components/chat/source-list'
import type { CitationSource } from '@/types/citation'
import type { Meta, StoryObj } from '@storybook/react-vite'

const meta = {
  title: 'Chat/SourceList',
  component: SourceList,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Container component that renders multiple SourceCard components. Automatically sorts sources to display primary source first, then additional sources in original order.',
      },
    },
  },
  decorators: [
    (Story) => (
      <div className="p-8 bg-background">
        <div className="max-w-2xl">
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta<typeof SourceList>

export default meta
type Story = StoryObj<typeof meta>

const sampleSources: CitationSource[] = [
  {
    id: 'src-1',
    title: 'The Future of AI-Powered Web Search',
    url: 'https://www.nature.com/articles/ai-search-2025',
    siteName: 'Nature',
    favicon: 'https://www.nature.com/favicon.ico',
    isPrimary: true,
  },
  {
    id: 'src-2',
    title: 'How Citation Systems Improve Trust in AI',
    url: 'https://www.theatlantic.com/technology/archive/2025/citations/',
    siteName: 'The Atlantic',
    favicon: 'https://www.theatlantic.com/favicon.ico',
  },
  {
    id: 'src-3',
    title: 'Building Transparent AI Systems',
    url: 'https://techcrunch.com/2025/01/15/transparent-ai',
    siteName: 'TechCrunch',
    favicon: 'https://techcrunch.com/favicon.ico',
  },
  {
    id: 'src-4',
    title: 'Ethics in AI Development',
    url: 'https://www.wired.com/story/ai-ethics-2025',
    siteName: 'WIRED',
    favicon: 'https://www.wired.com/favicon.ico',
  },
  {
    id: 'src-5',
    title: 'Trust and Transparency in Machine Learning',
    url: 'https://arxiv.org/abs/2501.12345',
    siteName: 'arXiv',
    favicon: 'https://arxiv.org/favicon.ico',
  },
]

export const SingleSource: Story = {
  args: {
    sources: [sampleSources[0]],
  },
  parameters: {
    docs: {
      description: {
        story: 'Source list with a single source.',
      },
    },
  },
}

export const TwoSources: Story = {
  args: {
    sources: [sampleSources[0], sampleSources[1]],
  },
  parameters: {
    docs: {
      description: {
        story: 'Source list with two sources. Primary source is displayed first.',
      },
    },
  },
}

export const MultipleSources: Story = {
  args: {
    sources: [sampleSources[0], sampleSources[1], sampleSources[2]],
  },
  parameters: {
    docs: {
      description: {
        story: 'Source list with three sources, showing typical usage.',
      },
    },
  },
}

export const FiveSources: Story = {
  args: {
    sources: sampleSources,
  },
  parameters: {
    docs: {
      description: {
        story: 'Source list with five sources. Content will scroll if container height is limited.',
      },
    },
  },
}

export const ManySources: Story = {
  args: {
    sources: [
      ...sampleSources,
      {
        id: 'src-6',
        title: 'AI Safety Research',
        url: 'https://www.openai.com/research/ai-safety',
        siteName: 'OpenAI',
        favicon: 'https://www.openai.com/favicon.ico',
      },
      {
        id: 'src-7',
        title: 'Responsible AI Practices',
        url: 'https://ai.google/responsibility/principles/',
        siteName: 'Google AI',
        favicon: 'https://ai.google/favicon.ico',
      },
      {
        id: 'src-8',
        title: 'Understanding Neural Networks',
        url: 'https://www.deeplearningbook.org/',
        siteName: 'Deep Learning Book',
      },
      {
        id: 'src-9',
        title: 'Machine Learning Best Practices',
        url: 'https://developers.google.com/machine-learning/guides',
        siteName: 'Google Developers',
        favicon: 'https://developers.google.com/favicon.ico',
      },
      {
        id: 'src-10',
        title: 'AI Research Papers',
        url: 'https://paperswithcode.com/',
        siteName: 'Papers with Code',
        favicon: 'https://paperswithcode.com/favicon.ico',
      },
    ],
  },
  parameters: {
    docs: {
      description: {
        story: 'Source list with 10+ sources. Demonstrates scrollable behavior in constrained containers.',
      },
    },
  },
}

export const PrimarySortingLast: Story = {
  args: {
    sources: [sampleSources[1], sampleSources[2], sampleSources[3], { ...sampleSources[4], isPrimary: true }],
  },
  parameters: {
    docs: {
      description: {
        story: 'Primary source is last in array but rendered first due to automatic sorting.',
      },
    },
  },
}

export const PrimarySortingMiddle: Story = {
  args: {
    sources: [sampleSources[1], { ...sampleSources[2], isPrimary: true }, sampleSources[3], sampleSources[4]],
  },
  parameters: {
    docs: {
      description: {
        story: 'Primary source is in the middle of array but rendered first.',
      },
    },
  },
}

export const NoPrimarySource: Story = {
  args: {
    sources: [
      { ...sampleSources[1], isPrimary: false },
      { ...sampleSources[2], isPrimary: false },
      { ...sampleSources[3], isPrimary: false },
    ],
  },
  parameters: {
    docs: {
      description: {
        story: 'Source list without primary source. All sources maintain their original order.',
      },
    },
  },
}

export const EmptyList: Story = {
  args: {
    sources: [],
  },
  parameters: {
    docs: {
      description: {
        story: 'Empty source list displays a "No sources available" message.',
      },
    },
  },
}

export const MixedCompleteness: Story = {
  args: {
    sources: [
      {
        id: 'src-complete',
        title: 'Complete Source with All Fields',
        url: 'https://www.nature.com/articles/ai-search-2025',
        siteName: 'Nature',
        favicon: 'https://www.nature.com/favicon.ico',
        isPrimary: true,
      },
      {
        id: 'src-no-favicon',
        title: 'Source Without Favicon',
        url: 'https://www.theatlantic.com/technology/',
        siteName: 'The Atlantic',
      },
      {
        id: 'src-no-site',
        title: 'Source Without Site Name',
        url: 'https://example.com/article',
        favicon: 'https://example.com/favicon.ico',
      },
      {
        id: 'src-minimal',
        title: '',
        url: 'https://minimal-source.com',
      },
    ],
  },
  parameters: {
    docs: {
      description: {
        story: 'Source list with mixed completeness levels. Shows how different sources render together.',
      },
    },
  },
}

export const ScrollableContainer = {
  render: () => (
    <div className="border rounded-lg p-4 max-h-96 overflow-y-auto">
      <h3 className="text-sm font-semibold mb-3">Sources (Scrollable)</h3>
      <SourceList
        sources={[
          ...sampleSources,
          {
            id: 'src-6',
            title: 'AI Safety Research',
            url: 'https://www.openai.com/research/ai-safety',
            siteName: 'OpenAI',
            favicon: 'https://www.openai.com/favicon.ico',
          },
          {
            id: 'src-7',
            title: 'Responsible AI Practices',
            url: 'https://ai.google/responsibility/principles/',
            siteName: 'Google AI',
            favicon: 'https://ai.google/favicon.ico',
          },
          {
            id: 'src-8',
            title: 'Understanding Neural Networks',
            url: 'https://www.deeplearningbook.org/',
            siteName: 'Deep Learning Book',
          },
        ]}
      />
    </div>
  ),
  parameters: {
    docs: {
      description: {
        story: 'Source list within a scrollable container with max-height constraint.',
      },
    },
  },
}

export const RealWorldExample = {
  render: () => (
    <div className="space-y-4">
      <div className="prose prose-sm max-w-none">
        <h2>Research Question: How do citation systems improve AI trust?</h2>
        <p>
          Citation systems in AI applications significantly improve user trust by providing transparency and
          verifiability. Studies show that users are more likely to trust AI-generated responses when they can verify
          the sources of information.
        </p>
      </div>
      <div className="border-t pt-4">
        <h3 className="text-sm font-semibold mb-3 text-muted-foreground">Sources</h3>
        <SourceList sources={sampleSources.slice(0, 3)} />
      </div>
    </div>
  ),
  parameters: {
    docs: {
      description: {
        story: 'Real-world example showing how SourceList appears in context with content.',
      },
    },
  },
}
