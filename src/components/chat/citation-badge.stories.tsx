import { CitationBadge } from '@/components/chat/citation-badge'
import { CitationPopoverProvider } from '@/components/chat/citation-popover'
import type { CitationSource } from '@/types/citation'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { createTestProvider } from '@/test-utils/test-provider'

const TestProvider = createTestProvider()

const meta = {
  title: 'Chat/CitationBadge',
  component: CitationBadge,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Inline citation badge that displays source references. Single source shows [Source Name], multiple sources show [Primary Source +N]. Click to open modal with detailed source information.',
      },
    },
  },
  decorators: [
    (Story) => (
      <TestProvider>
        <CitationPopoverProvider>
          <div className="p-8 bg-background">
            <div className="max-w-2xl">
              <p className="text-sm leading-relaxed">
                This is example text with a citation <Story /> that you can click to view source details.
              </p>
            </div>
          </div>
        </CitationPopoverProvider>
      </TestProvider>
    ),
  ],
} satisfies Meta<typeof CitationBadge>

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
    citationId: 0,
  },
  parameters: {
    docs: {
      description: {
        story: 'Citation badge with a single source. Displays as [Source Name] without count.',
      },
    },
  },
}

export const TwoSources: Story = {
  args: {
    sources: [sampleSources[0], sampleSources[1]],
    citationId: 1,
  },
  parameters: {
    docs: {
      description: {
        story: 'Citation badge with two sources. Displays as [Primary Source +1].',
      },
    },
  },
}

export const MultipleSources: Story = {
  args: {
    sources: [sampleSources[0], sampleSources[1], sampleSources[2]],
    citationId: 2,
  },
  parameters: {
    docs: {
      description: {
        story: 'Citation badge with three sources. Primary source is displayed with additional count.',
      },
    },
  },
}

export const ManySources: Story = {
  args: {
    sources: sampleSources,
    citationId: 3,
  },
  parameters: {
    docs: {
      description: {
        story: 'Citation badge with five sources. Modal will show all sources in a scrollable list.',
      },
    },
  },
}

export const LongSourceName: Story = {
  args: {
    sources: [
      {
        id: 'src-long',
        title: 'A Comprehensive Analysis of Machine Learning Algorithms in Natural Language Processing',
        url: 'https://www.example.com/very-long-article-title',
        siteName: 'International Journal of Artificial Intelligence Research',
        favicon: 'https://www.example.com/favicon.ico',
        isPrimary: true,
      },
    ],
    citationId: 4,
  },
  parameters: {
    docs: {
      description: {
        story: 'Citation badge with a very long source name to test truncation and display behavior.',
      },
    },
  },
}

export const NoPrimarySources: Story = {
  args: {
    sources: [
      { ...sampleSources[1], isPrimary: false },
      { ...sampleSources[2], isPrimary: false },
      { ...sampleSources[3], isPrimary: false },
    ],
    citationId: 5,
  },
  parameters: {
    docs: {
      description: {
        story: 'Citation badge when no source is marked as primary. First source is used as default.',
      },
    },
  },
}

export const MissingSiteName: Story = {
  args: {
    sources: [
      {
        id: 'src-no-site',
        title: 'Article Without Site Name',
        url: 'https://example.com/article',
        isPrimary: true,
      },
    ],
    citationId: 6,
  },
  parameters: {
    docs: {
      description: {
        story: 'Citation badge when source has no siteName. Falls back to displaying the title.',
      },
    },
  },
}

export const EmptySources: Story = {
  args: {
    sources: [],
    citationId: 7,
  },
  parameters: {
    docs: {
      description: {
        story: 'Citation badge with empty sources array. Component renders null (nothing displayed).',
      },
    },
  },
}

export const InteractiveDemo = {
  render: () => (
    <TestProvider>
      <CitationPopoverProvider>
        <div className="space-y-6 max-w-2xl">
          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Different Citation Counts</h3>
            <div className="space-y-2 text-sm">
              <p>
                Single source citation <CitationBadge sources={[sampleSources[0]]} citationId={0} /> shows just the
                name.
              </p>
              <p>
                Two sources <CitationBadge sources={[sampleSources[0], sampleSources[1]]} citationId={1} /> displays
                with +1 count.
              </p>
              <p>
                Multiple sources <CitationBadge sources={sampleSources.slice(0, 3)} citationId={2} /> shows +2 count.
              </p>
              <p>
                Many sources <CitationBadge sources={sampleSources} citationId={3} /> can be clicked to view all in
                modal.
              </p>
            </div>
          </div>
        </div>
      </CitationPopoverProvider>
    </TestProvider>
  ),
  parameters: {
    docs: {
      description: {
        story: 'Interactive demo showing different citation badge variations in context.',
      },
    },
  },
}
