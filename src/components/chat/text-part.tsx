import { type TextUIPart } from 'ai'
import { StreamingMarkdown } from './streaming-markdown'

interface TextPartProps {
  part: TextUIPart
}

export const TextPart = ({ part }: TextPartProps) => {
  return (
    <div className="p-4 rounded-md mr-auto w-full my-2">
      <StreamingMarkdown
        content={part.text || ''}
        isStreaming={part.state === 'streaming'}
        className="text-secondary-foreground leading-relaxed"
      />
    </div>
  )
}
