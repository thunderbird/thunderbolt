import { memo } from 'react'
import { Button } from '../ui/button'

interface SuggestionButtonProps {
  label: string
  prompt: string
  onSelect: (prompt: string) => void
}

const SuggestionButton = ({ label, prompt, onSelect }: SuggestionButtonProps) => (
  <Button
    variant="outline"
    className="bg-card text-sm text-foreground rounded-full px-3 py-1.5 border border-border hover:bg-accent whitespace-nowrap flex-shrink-0 shadow-none"
    onClick={() => onSelect(prompt)}
  >
    {label}
  </Button>
)

export const SuggestionButtons = memo(({ onSelectPrompt }: { onSelectPrompt: (prompt: string) => void }) => {
  const suggestions = [
    { label: 'Check the weather', prompt: 'What is the forecast for this week?' },
    { label: 'Check your to dos', prompt: 'What are my current tasks?' },
    {
      label: 'Write a message',
      prompt: 'Write a thank you email to my coworker for helping with the meeting yesterday.',
    },
    {
      label: 'Understand a topic',
      prompt: 'Explain how checks and balances work between the three branches of government.',
    },
  ]

  return (
    <div className="flex gap-3 justify-start w-full max-w-[696px] mx-auto overflow-x-auto scrollbar-hide pb-px">
      {suggestions.map((suggestion, index) => (
        <SuggestionButton key={index} label={suggestion.label} prompt={suggestion.prompt} onSelect={onSelectPrompt} />
      ))}
    </div>
  )
})
