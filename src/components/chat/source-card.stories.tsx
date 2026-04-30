/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SourceCard } from '@/components/chat/source-card'
import { ExternalLinkDialogProvider } from '@/components/chat/markdown-utils'
import type { CitationSource } from '@/types/citation'
import type { Meta, StoryObj } from '@storybook/react-vite'

const meta = {
  title: 'Chat/SourceCard',
  component: SourceCard,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Displays metadata for a single citation source. Shows favicon (with fallback), site name, title, and clickable URL. Used within SourceList to display multiple sources.',
      },
    },
  },
  decorators: [
    (Story) => (
      <ExternalLinkDialogProvider>
        <div className="p-8 bg-background">
          <div className="max-w-xl">
            <Story />
          </div>
        </div>
      </ExternalLinkDialogProvider>
    ),
  ],
} satisfies Meta<typeof SourceCard>

export default meta
type Story = StoryObj<typeof meta>

const completeSources: CitationSource = {
  id: 'src-1',
  title: 'The Future of AI-Powered Web Search',
  url: 'https://www.nature.com/articles/ai-search-2025',
  siteName: 'Nature',
  favicon: 'https://www.nature.com/favicon.ico',
  isPrimary: true,
}

export const Complete: Story = {
  args: {
    source: completeSources,
  },
  parameters: {
    docs: {
      description: {
        story: 'Source card with all fields present: favicon, site name, title, and URL.',
      },
    },
  },
}

export const MissingFavicon: Story = {
  args: {
    source: {
      id: 'src-no-favicon',
      title: 'How Citation Systems Improve Trust in AI',
      url: 'https://www.theatlantic.com/technology/archive/2025/citations/',
      siteName: 'The Atlantic',
    },
  },
  parameters: {
    docs: {
      description: {
        story: 'Source card without favicon. Falls back to displaying a Globe icon.',
      },
    },
  },
}

export const InvalidFavicon: Story = {
  args: {
    source: {
      id: 'src-invalid-favicon',
      title: 'Building Transparent AI Systems',
      url: 'https://techcrunch.com/2025/01/15/transparent-ai',
      siteName: 'TechCrunch',
      favicon: 'https://invalid-url.com/nonexistent-favicon.ico',
    },
  },
  parameters: {
    docs: {
      description: {
        story: 'Source card with invalid/broken favicon URL. Falls back to Globe icon on error.',
      },
    },
  },
}

export const MissingTitle: Story = {
  args: {
    source: {
      id: 'src-no-title',
      title: '',
      url: 'https://www.example.com/some-article',
      siteName: 'Example Site',
      favicon: 'https://www.example.com/favicon.ico',
    },
  },
  parameters: {
    docs: {
      description: {
        story: 'Source card with missing title. Falls back to displaying the URL as title.',
      },
    },
  },
}

export const MissingSiteName: Story = {
  args: {
    source: {
      id: 'src-no-site',
      title: 'Article Without Site Name',
      url: 'https://example.com/article',
      favicon: 'https://example.com/favicon.ico',
    },
  },
  parameters: {
    docs: {
      description: {
        story: 'Source card without site name. Only favicon and title are displayed.',
      },
    },
  },
}

export const VeryLongTitle: Story = {
  args: {
    source: {
      id: 'src-long-title',
      title:
        'A Comprehensive and Detailed Analysis of Modern Machine Learning Algorithms and Their Applications in Contemporary Natural Language Processing Systems',
      url: 'https://arxiv.org/abs/2501.12345',
      siteName: 'arXiv',
      favicon: 'https://arxiv.org/favicon.ico',
    },
  },
  parameters: {
    docs: {
      description: {
        story: 'Source card with very long title. Title wraps naturally without truncation.',
      },
    },
  },
}

export const VeryLongURL: Story = {
  args: {
    source: {
      id: 'src-long-url',
      title: 'Understanding URL Truncation',
      url: 'https://www.example.com/very/long/path/with/many/segments/and/parameters?param1=value1&param2=value2&param3=value3&param4=value4',
      siteName: 'Example Site',
      favicon: 'https://www.example.com/favicon.ico',
    },
  },
  parameters: {
    docs: {
      description: {
        story: 'Source card with very long URL. URL is truncated with line-clamp-1 class.',
      },
    },
  },
}

export const MinimalSource: Story = {
  args: {
    source: {
      id: 'src-minimal',
      title: '',
      url: 'https://example.com',
    },
  },
  parameters: {
    docs: {
      description: {
        story: 'Minimal source card with only required fields. URL is used as title, Globe icon as fallback.',
      },
    },
  },
}

export const GitHubSource: Story = {
  args: {
    source: {
      id: 'src-github',
      title: 'Build Software Better, Together',
      url: 'https://github.com/mozilla/thunderbolt',
      siteName: 'GitHub',
      favicon: 'https://github.com/favicon.ico',
    },
  },
  parameters: {
    docs: {
      description: {
        story: 'Example source card pointing to a GitHub repository.',
      },
    },
  },
}

export const WikipediaSource: Story = {
  args: {
    source: {
      id: 'src-wikipedia',
      title: 'Artificial Intelligence',
      url: 'https://en.wikipedia.org/wiki/Artificial_intelligence',
      siteName: 'Wikipedia',
      favicon: 'https://en.wikipedia.org/favicon.ico',
    },
  },
  parameters: {
    docs: {
      description: {
        story: 'Example source card pointing to a Wikipedia article.',
      },
    },
  },
}

export const AllVariants = {
  render: () => (
    <div className="space-y-4 max-w-xl">
      <div>
        <h3 className="text-sm font-semibold mb-2">Complete Source</h3>
        <SourceCard
          source={{
            id: '1',
            title: 'The Future of AI-Powered Web Search',
            url: 'https://www.nature.com/articles/ai-search-2025',
            siteName: 'Nature',
            favicon: 'https://www.nature.com/favicon.ico',
          }}
        />
      </div>
      <div>
        <h3 className="text-sm font-semibold mb-2">Missing Favicon</h3>
        <SourceCard
          source={{
            id: '2',
            title: 'How Citation Systems Improve Trust in AI',
            url: 'https://www.theatlantic.com/technology/archive/2025/citations/',
            siteName: 'The Atlantic',
          }}
        />
      </div>
      <div>
        <h3 className="text-sm font-semibold mb-2">Missing Site Name</h3>
        <SourceCard
          source={{
            id: '3',
            title: 'Article Without Site Name',
            url: 'https://example.com/article',
            favicon: 'https://example.com/favicon.ico',
          }}
        />
      </div>
      <div>
        <h3 className="text-sm font-semibold mb-2">Minimal (URL as title)</h3>
        <SourceCard
          source={{
            id: '4',
            title: '',
            url: 'https://example.com',
          }}
        />
      </div>
    </div>
  ),
  parameters: {
    docs: {
      description: {
        story: 'All source card variants displayed together for comparison.',
      },
    },
  },
}
