import type { Meta, StoryObj } from '@storybook/react-vite'
import { LinkPreview } from './display'
import { LinkPreviewSkeleton } from './widget'

const meta = {
  title: 'widgets/link-preview',
  component: LinkPreview,
  parameters: {
    layout: 'centered',
    docs: {
      story: {
        inline: false,
        iframeHeight: 200,
      },
    },
  },
  decorators: [
    (Story) => (
      <div style={{ minWidth: '400px', width: '100%', maxWidth: '600px' }}>
        <Story />
      </div>
    ),
  ],
  tags: ['autodocs'],
  argTypes: {
    url: {
      description: 'The URL to preview',
      control: { type: 'text' },
    },
    title: {
      description: 'Title of the link preview',
      control: { type: 'text' },
    },
    description: {
      description: 'Description of the link preview',
      control: { type: 'text' },
    },
    image: {
      description: 'URL of the preview image',
      control: { type: 'text' },
    },
  },
} satisfies Meta<typeof LinkPreview>

export default meta
type Story = StoryObj<typeof meta>

export const WithImage: Story = {
  args: {
    url: 'https://github.com/features/copilot',
    title: 'GitHub Copilot · Your AI pair programmer',
    description:
      'GitHub Copilot uses OpenAI Codex to suggest code and entire functions in real-time, right from your editor.',
    image: 'https://github.githubassets.com/images/modules/site/social-cards/copilot.png',
  },
  parameters: {
    docs: {
      description: {
        story: 'Link preview with an image, title, and description',
      },
    },
  },
}

export const WithoutImage: Story = {
  args: {
    url: 'https://example.com/article',
    title: 'Understanding TypeScript',
    description: 'A comprehensive guide to TypeScript, covering types, interfaces, generics, and advanced patterns.',
    image: null,
  },
  parameters: {
    docs: {
      description: {
        story: 'Link preview without an image - shows gray placeholder',
      },
    },
  },
}

export const Loading: Story = {
  args: {
    url: 'https://example.com',
    title: 'Loading...',
    description: null,
    image: null,
  },
  render: () => <LinkPreviewSkeleton />,
  parameters: {
    docs: {
      description: {
        story: 'Loading state while fetching link preview data',
      },
    },
  },
}

export const LongTitle: Story = {
  args: {
    url: 'https://example.com/very-long-article',
    title:
      'This is an extremely long title that should be truncated with an ellipsis when it exceeds the available width',
    description: 'This article has a very long title to demonstrate truncation behavior.',
    image: 'https://github.githubassets.com/images/modules/site/social-cards/github-social.png',
  },
  parameters: {
    docs: {
      description: {
        story: 'Link preview with a long title that gets truncated',
      },
    },
  },
}

export const LongDescription: Story = {
  args: {
    url: 'https://example.com/detailed-article',
    title: 'Article with Detailed Description',
    description:
      'This is a very long description that should be truncated after two lines. It contains a lot of text to demonstrate how the component handles lengthy descriptions. The description should be clamped to two lines and show an ellipsis when it overflows the available space.',
    image: 'https://github.githubassets.com/images/modules/site/social-cards/github-social.png',
  },
  parameters: {
    docs: {
      description: {
        story: 'Link preview with a long description that gets truncated to 2 lines',
      },
    },
  },
}

export const NoDescription: Story = {
  args: {
    url: 'https://example.com',
    title: 'Example Website',
    description: null,
    image: 'https://github.githubassets.com/images/modules/site/social-cards/github-social.png',
  },
  parameters: {
    docs: {
      description: {
        story: 'Link preview with only a title, no description',
      },
    },
  },
}

export const MinimalWithoutImage: Story = {
  args: {
    url: 'https://example.com',
    title: 'Example Website',
    description: null,
    image: null,
  },
  parameters: {
    docs: {
      description: {
        story: 'Minimal link preview with just a title and placeholder image',
      },
    },
  },
}

export const RealWorldExample: Story = {
  args: {
    url: 'https://openai.com/blog/chatgpt',
    title: 'ChatGPT: Optimizing Language Models for Dialogue',
    description:
      "We've trained a model called ChatGPT which interacts in a conversational way. The dialogue format makes it possible for ChatGPT to answer followup questions, admit its mistakes, challenge incorrect premises, and reject inappropriate requests.",
    image: 'https://images.openai.com/blob/cf717bdb-0c8c-428a-b82b-3c3add87a600/ChatGPT.png',
  },
  parameters: {
    docs: {
      description: {
        story: 'Real-world example of a link preview',
      },
    },
  },
}

export const ImageError: Story = {
  args: {
    url: 'https://example.com/broken-image',
    title: 'Article with Broken Image',
    description: 'This article has an image URL that will fail to load, showing the placeholder instead.',
    image: 'https://invalid-url-that-will-fail-to-load.example.com/image.jpg',
  },
  parameters: {
    docs: {
      description: {
        story: 'Link preview with an image that fails to load - falls back to placeholder',
      },
    },
  },
}

export const HostnameAsTitleFallback: Story = {
  args: {
    url: 'https://www.example.com/some/long/path',
    title: 'example.com',
    description: 'A page where the hostname is used as the title fallback instead of the full URL',
    image: null,
  },
  parameters: {
    docs: {
      description: {
        story: 'When no og:title is found, the hostname is used as the title instead of the full URL',
      },
    },
  },
}

export const MinimalPreview: Story = {
  args: {
    url: 'https://blocked-site.example.com/captcha',
    title: 'blocked-site.example.com',
    description: null,
    image: null,
  },
  parameters: {
    docs: {
      description: {
        story: 'Minimal preview card shown when no metadata was found (e.g., captcha pages) - uses hostname as title',
      },
    },
  },
}

export const MinimalPreviewLongHostname: Story = {
  args: {
    url: 'https://very-long-subdomain.deeply-nested.example.co.uk/path',
    title: 'very-long-subdomain.deeply-nested.example.co.uk',
    description: null,
    image: null,
  },
  parameters: {
    docs: {
      description: {
        story: 'Minimal preview card with a long hostname to verify truncation',
      },
    },
  },
}
